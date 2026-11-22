'use strict';
/**
 * #R8 slice 2 — Drag-and-drop for the staged upload client layer
 *
 * The validator plugin's staged upload layer (`data-gina-form-upload-*`) gains
 * an opt-in, attribute-marked dropzone: a file input carrying
 * `data-gina-form-upload-dropzone="<elementId>"` gets drag listeners bound on
 * the named element at form-bind time, and files dropped there route through
 * the EXACT same staging pipeline as a native picker selection — the drop
 * assigns the dropped `FileList` to the input and re-fires the input's
 * `change` (the form-reset synthetic-change idiom), so group tagging, the
 * virtual form, the staging POST, previews, hidden metadata fields,
 * reset/delete and upload progress all run with zero duplicated logic.
 *
 * Contract:
 *  - EXPLICIT-ONLY targeting: no default id resolution (unlike
 *    -preview/-error/-progress). Absent attribute → inert; attribute present
 *    but element missing → console.warn + inert.
 *  - Binding marker `data-gina-upload-dropzone` (value = owner input id),
 *    first-wins: a zone serves exactly one input; same-owner re-binding is a
 *    silent no-op, a second input warns + skips.
 *  - State hook `data-gina-upload-dropzone-state`: idle → over (file drag
 *    hovers) → dropped (upload in flight) → idle again at the onUpload
 *    complete/error chokepoint and at the reset/delete strip. Pure CSS hook,
 *    no hardcoded wording.
 *  - Only file drags react (`dataTransfer.types` carries `Files`); text/link
 *    drags fall through untouched. Multi-file drops on a non-`multiple` input
 *    keep the FIRST file only (console.warn).
 *
 * Strategy:
 *  - Source-inspection pins lock the structural shape (bind-time call site
 *    before the change listener, explicit-only resolution, uploadProperties
 *    stash, the two idle-finalize chokepoints, no new registered event).
 *  - Both helpers are EXTRACTED from the shipped source at run time
 *    (brace-walk, control-gated) and executed — the state helper against a
 *    jsdom document, the bind function against a jsdom zone + recorder stubs
 *    (addListener/triggerEvent/console/DataTransfer) so the whole drag
 *    choreography is driven behaviourally on the exact shipped bytes.
 *  - Dist-fidelity pins assert the built browser bundles carry the new
 *    attribute string literals (they survive Closure SIMPLE mode); they are
 *    expected RED before the bundle rebuild and green after — the transition
 *    is the subtract control proving they detect a stale artifact.
 *
 * Usage: node --test test/core/validator-upload-dropzone.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW       = require('../fw');
var commentStrip = require('../strip-comments');
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
    return commentStrip.lines(src);
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

var STATE_DECL = 'var updateUploadDropzoneState = function(dropzoneId, state) {';
var BIND_DECL  = 'var bindUploadDropzone = function($uploadTrigger) {';

/**
 * Builds a stub file input carrying only the surface bindUploadDropzone
 * touches: getAttribute, id, multiple and the assignable files slot.
 *
 * @param {string} id
 * @param {object|null} attrs - attribute map served by getAttribute
 * @param {boolean} [multiple]
 * @returns {object}
 */
function stubInput(id, attrs, multiple) {
    return {
        id: id,
        multiple: !!multiple,
        files: null,
        getAttribute: function (name) {
            return (attrs && Object.prototype.hasOwnProperty.call(attrs, name)) ? attrs[name] : null;
        }
    };
}

/**
 * Builds a fake drag event: a dataTransfer with the given types/files (or
 * none when types is null) plus a preventDefault recorder.
 *
 * @param {string[]|null} types - dataTransfer.types (null = no dataTransfer)
 * @param {object[]} [files]
 * @returns {object}
 */
function mkEvt(types, files) {
    var evt = {
        prevented: false,
        preventDefault: function () { evt.prevented = true; }
    };
    evt.dataTransfer = (types === null) ? null : { types: types, files: files || [], dropEffect: '' };
    return evt;
}

/**
 * Minimal DataTransfer stand-in for the truncation branch: items.add()
 * accumulates into the .files list.
 *
 * @constructor
 */
function StubDataTransfer() {
    var files = [];
    this.items = { add: function (f) { files.push(f); } };
    Object.defineProperty(this, 'files', { get: function () { return files; } });
}

/**
 * Materialises both extracted helpers against a fresh jsdom document plus
 * recorder stubs, and returns the whole harness.
 *
 * @param {string} [bodyHtml]
 * @returns {object} { bind, state, doc, listeners, dispatches, warns, handler }
 */
function freshHarness(bodyHtml) {
    var dom = new JSDOM('<!doctype html><html><body>' +
        (bodyHtml || '<div id="dz1"><span id="dz1-child"></span></div>') +
        '</body></html>');
    var doc = dom.window.document;

    var stateText = extractFunctionExpression(SRC, STATE_DECL);
    /* jshint evil: true */
    var state = new Function('document', 'return (' + stateText + ');')(doc);

    var listeners  = [];
    var dispatches = [];
    var warns      = [];
    var gina       = { __stub: true };

    var addListenerStub = function (target, element, name, fn) {
        listeners.push({ target: target, element: element, name: name, fn: fn });
    };
    var triggerEventStub = function (target, element, name, args) {
        dispatches.push({ target: target, element: element, name: name, args: args });
    };
    var consoleStub = {
        warn:  function (msg) { warns.push(String(msg)); },
        debug: function () {},
        log:   function () {}
    };

    var bindText = extractFunctionExpression(SRC, BIND_DECL);
    var bind = new Function(
        'document', 'console', 'addListener', 'triggerEvent',
        'updateUploadDropzoneState', 'gina', 'DataTransfer',
        'return (' + bindText + ');'
    )(doc, consoleStub, addListenerStub, triggerEventStub, state, gina, StubDataTransfer);

    return {
        bind: bind,
        state: state,
        doc: doc,
        gina: gina,
        listeners: listeners,
        dispatches: dispatches,
        warns: warns,
        /**
         * Returns the captured listener callback for an event name.
         *
         * @param {string} name
         * @returns {function}
         */
        handler: function (name) {
            var found = listeners.filter(function (l) { return l.name === name; });
            assert.equal(found.length, 1, 'exactly one ' + name + ' listener bound');
            return found[0].fn;
        }
    };
}


describe('#R8s2 §01 — source pins: wiring, explicit-only resolution, chokepoints', function () {

    it('bindUploadDropzone is called at form-bind time, before the file change listener', function () {
        var callIdx   = SRC.indexOf('bindUploadDropzone($inputs[f]);');
        var changeIdx = SRC.indexOf("addListener(gina, $inputs[f], 'change'");
        assert.ok(callIdx >= 0, 'bind-time call site present');
        assert.ok(changeIdx >= 0, 'file change listener present');
        assert.ok(callIdx < changeIdx,
            'dropzone binds BEFORE the change listener — a drop can be the first interaction');
        assert.equal(SRC.indexOf('bindUploadDropzone($inputs[f]);', callIdx + 1), -1,
            'exactly one bind-time call site');
    });

    it('the create-only block resolves the dropzone target explicit-only (no default id)', function () {
        assert.match(SRC,
            /var dropzoneContainer\s*=\s*\$el\.getAttribute\('data-gina-form-upload-dropzone'\) \|\| null;/,
            'resolution falls back to null, never a derived id');
        // window-independent negative: the default-id concat form must be
        // globally absent from active code (the -progress/-preview family
        // derives defaults this way; the dropzone deliberately must not)
        var active = stripComments(SRC);
        assert.ok(active.indexOf("+ '-dropzone'") < 0,
            'no <fieldId>-dropzone default derivation anywhere');
    });

    it('uploadProperties carries the resolved dropzoneContainer string id', function () {
        assert.match(SRC, /dropzoneContainer\s*:\s*dropzoneContainer,/,
            'stash sits alongside progressContainer');
    });

    it('onUpload finalizes the dropzone to idle right after the progress finalize (single chokepoint)', function () {
        var progressFinalizeIdx = SRC.indexOf('uploadProperties.progressContainer || null');
        var dropzoneFinalizeIdx = SRC.indexOf(
            "updateUploadDropzoneState(uploadProperties.dropzoneContainer || null, 'idle');");
        assert.ok(progressFinalizeIdx >= 0 && dropzoneFinalizeIdx >= 0);
        assert.ok(dropzoneFinalizeIdx > progressFinalizeIdx,
            'dropzone idle follows the progress finalize at the same chokepoint');
        assert.equal(SRC.indexOf(
            "updateUploadDropzoneState(uploadProperties.dropzoneContainer || null, 'idle');",
            dropzoneFinalizeIdx + 1), -1, 'exactly one onUpload finalize site');
    });

    it('the reset/delete strip returns the dropzone to idle inside the removedCount gate', function () {
        var stripLine = "updateUploadDropzoneState($uploadTrigger.getAttribute('data-gina-form-upload-dropzone') || null, 'idle');";
        var gateIdx  = SRC.indexOf('if (removedCount > 0) {');
        var progressStripIdx = SRC.indexOf("$uploadTrigger.getAttribute('data-gina-form-upload-progress')");
        var stripIdx = SRC.indexOf(stripLine);
        assert.ok(gateIdx >= 0 && progressStripIdx >= 0 && stripIdx >= 0);
        assert.ok(gateIdx < progressStripIdx && progressStripIdx < stripIdx,
            'gate → progress strip → dropzone idle, in order');
        assert.equal(SRC.indexOf(stripLine, stripIdx + 1), -1,
            'exactly one reset/delete strip site');
        // the strip reads the attribute bare — no default-id fallback (the
        // global explicit-only negative in the resolution pin covers the
        // concat form; this locks the strip site reads `|| null`)
        assert.match(SRC,
            /updateUploadDropzoneState\(\$uploadTrigger\.getAttribute\('data-gina-form-upload-dropzone'\) \|\| null, 'idle'\);/);
    });

    it('no new registered validator event (the layer is attribute + state only)', function () {
        var start = SRC.indexOf('var events      = [');
        assert.ok(start >= 0, 'events array declaration found');
        var end = SRC.indexOf('];', start);
        var block = SRC.substring(start, end);
        assert.doesNotMatch(block, /dropzone/i,
            'no dropzone event name registered — drops reuse the change→uploadProgress lifecycle');
    });
});


describe('#R8s2 §02 — updateUploadDropzoneState (extracted shipped bytes, jsdom-driven)', function () {

    it('extraction control: the declaration matches exactly once and walks to balance', function () {
        var fnText = extractFunctionExpression(SRC, STATE_DECL);
        assert.ok(fnText.length > 100 && fnText.length < 1200, 'sane extraction size');
        assert.ok(/^function\(dropzoneId, state\) \{/.test(fnText));
        assert.ok(/\}$/.test(fnText));
    });

    it('null id and unknown ids are silent no-ops', function () {
        var h = freshHarness();
        assert.doesNotThrow(function () { h.state(null, 'over'); });
        assert.doesNotThrow(function () { h.state('nope', 'over'); });
    });

    it('sets only the state attribute — never the marker, never text', function () {
        var h = freshHarness();
        var $z = h.doc.getElementById('dz1');
        h.state('dz1', 'over');
        assert.equal($z.getAttribute('data-gina-upload-dropzone-state'), 'over');
        assert.equal($z.getAttribute('data-gina-upload-dropzone'), null,
            'the marker belongs to bindUploadDropzone alone');
        assert.equal($z.textContent, '', 'no wording is ever written');
        h.state('dz1', 'idle');
        assert.equal($z.getAttribute('data-gina-upload-dropzone-state'), 'idle');
    });
});


describe('#R8s2 §03 — bindUploadDropzone: opt-in, explicit-only, first-wins', function () {

    it('extraction control: the declaration matches exactly once and walks to balance', function () {
        var fnText = extractFunctionExpression(SRC, BIND_DECL);
        assert.ok(fnText.length > 1000 && fnText.length < 8000, 'sane extraction size');
        assert.ok(/^function\(\$uploadTrigger\) \{/.test(fnText));
        assert.ok(/\}$/.test(fnText));
    });

    it('no attribute → fully inert (no listeners, no marker, no warn)', function () {
        var h = freshHarness();
        h.bind(stubInput('up1', null));
        assert.equal(h.listeners.length, 0);
        assert.equal(h.warns.length, 0);
        assert.equal(h.doc.getElementById('dz1').getAttribute('data-gina-upload-dropzone'), null);
    });

    it('attribute present but element missing → console.warn + inert', function () {
        var h = freshHarness();
        h.bind(stubInput('up1', { 'data-gina-form-upload-dropzone': 'no-such-zone' }));
        assert.equal(h.listeners.length, 0);
        assert.equal(h.warns.length, 1);
        assert.match(h.warns[0], /no-such-zone/);
        assert.match(h.warns[0], /up1/);
    });

    it('binds: marker = owner id, state = idle, all four drag listeners on the zone', function () {
        var h = freshHarness();
        var $z = h.doc.getElementById('dz1');
        h.bind(stubInput('up1', { 'data-gina-form-upload-dropzone': 'dz1' }));
        assert.equal($z.getAttribute('data-gina-upload-dropzone'), 'up1');
        assert.equal($z.getAttribute('data-gina-upload-dropzone-state'), 'idle');
        var names = h.listeners.map(function (l) { return l.name; }).sort();
        assert.deepEqual(names, ['dragenter', 'dragleave', 'dragover', 'drop']);
        h.listeners.forEach(function (l) {
            assert.equal(l.element, $z, 'listener bound on the zone element');
            assert.equal(l.target, h.gina, 'bound through the gina event registry');
        });
        assert.equal(h.warns.length, 0);
    });

    it('first-wins: same owner re-binding is a silent no-op; a second input warns + skips', function () {
        var h = freshHarness();
        var attrs = { 'data-gina-form-upload-dropzone': 'dz1' };
        h.bind(stubInput('up1', attrs));
        assert.equal(h.listeners.length, 4);

        // same owner again (form re-bind cycle): no new listeners, no warn
        h.bind(stubInput('up1', attrs));
        assert.equal(h.listeners.length, 4, 'no double-binding');
        assert.equal(h.warns.length, 0, 'same-owner re-bind is silent');

        // a different input claiming the same zone: warn + skip
        h.bind(stubInput('up2', attrs));
        assert.equal(h.listeners.length, 4, 'zone stays with its first owner');
        assert.equal(h.warns.length, 1);
        assert.match(h.warns[0], /dz1/);
        assert.match(h.warns[0], /up1/);
        assert.match(h.warns[0], /up2/);
        assert.equal(h.doc.getElementById('dz1').getAttribute('data-gina-upload-dropzone'), 'up1');
    });
});


describe('#R8s2 §04 — drag choreography (captured handlers, real state writes)', function () {

    /**
     * Binds a zone for an input and returns the harness with handlers live.
     *
     * @param {boolean} [multiple]
     * @returns {object} { h, input, $z }
     */
    function bound(multiple) {
        var h = freshHarness();
        var input = stubInput('up1', { 'data-gina-form-upload-dropzone': 'dz1' }, multiple);
        h.bind(input);
        return { h: h, input: input, $z: h.doc.getElementById('dz1') };
    }

    it('dragenter with a file payload prevents default and goes over', function () {
        var b = bound();
        var evt = mkEvt(['Files']);
        b.h.handler('dragenter')(evt);
        assert.equal(evt.prevented, true);
        assert.equal(b.$z.getAttribute('data-gina-upload-dropzone-state'), 'over');
    });

    it('non-file drags fall through untouched on every listener', function () {
        var b = bound();
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (name) {
            var evt = mkEvt(['text/plain', 'text/uri-list']);
            b.h.handler(name)(evt);
            assert.equal(evt.prevented, false, name + ' never prevents a text/link drag');
        });
        var noDt = mkEvt(null);
        b.h.handler('dragenter')(noDt);
        assert.equal(noDt.prevented, false, 'missing dataTransfer is ignored');
        assert.equal(b.$z.getAttribute('data-gina-upload-dropzone-state'), 'idle');
        assert.equal(b.h.dispatches.length, 0);
    });

    it('child-boundary crossings do not flicker: depth-counted enter/leave', function () {
        var b = bound();
        b.h.handler('dragenter')(mkEvt(['Files'])); // zone
        b.h.handler('dragenter')(mkEvt(['Files'])); // child
        b.h.handler('dragleave')(mkEvt(['Files'])); // child → zone
        assert.equal(b.$z.getAttribute('data-gina-upload-dropzone-state'), 'over',
            'still over after an inner boundary crossing');
        b.h.handler('dragleave')(mkEvt(['Files'])); // zone exit
        assert.equal(b.$z.getAttribute('data-gina-upload-dropzone-state'), 'idle');
    });

    it('dragover prevents default (drop permission) and requests the copy effect', function () {
        var b = bound();
        var evt = mkEvt(['Files']);
        b.h.handler('dragover')(evt);
        assert.equal(evt.prevented, true);
        assert.equal(evt.dataTransfer.dropEffect, 'copy');
    });

    it('drop routes through the pipeline: assign files, state dropped, synthetic change', function () {
        var b = bound();
        var f1 = { name: 'photo1.jpg' };
        var evt = mkEvt(['Files'], [f1]);
        b.h.handler('drop')(evt);
        assert.equal(evt.prevented, true);
        assert.equal(b.input.files.length, 1);
        assert.equal(b.input.files[0], f1, 'the dropped FileList is assigned as-is');
        assert.equal(b.$z.getAttribute('data-gina-upload-dropzone-state'), 'dropped');
        assert.equal(b.h.dispatches.length, 1);
        assert.equal(b.h.dispatches[0].element, b.input);
        assert.equal(b.h.dispatches[0].name, 'change',
            'the synthetic change drives the existing staging pipeline');
    });

    it('an empty file drop settles back to idle without dispatching', function () {
        var b = bound();
        var evt = mkEvt(['Files'], []);
        b.h.handler('drop')(evt);
        assert.equal(b.input.files, null, 'nothing assigned');
        assert.equal(b.h.dispatches.length, 0, 'no synthetic change');
        assert.equal(b.$z.getAttribute('data-gina-upload-dropzone-state'), 'idle');
    });

    it('multi-file drop on a non-multiple input keeps the first file only, with a warn', function () {
        var b = bound(false);
        var f1 = { name: 'a.jpg' }, f2 = { name: 'b.jpg' }, f3 = { name: 'c.jpg' };
        var evt = mkEvt(['Files'], [f1, f2, f3]);
        b.h.handler('drop')(evt);
        assert.equal(b.h.warns.length, 1);
        assert.match(b.h.warns[0], /3 files/);
        assert.match(b.h.warns[0], /first file only/);
        assert.equal(b.input.files.length, 1, 'truncated to one');
        assert.equal(b.input.files[0], f1, 'the FIRST file is kept');
        assert.equal(b.h.dispatches.length, 1, 'the truncated selection still stages');
        assert.equal(b.$z.getAttribute('data-gina-upload-dropzone-state'), 'dropped');
    });

    it('multi-file drop on a multiple input keeps every file, silently', function () {
        var b = bound(true);
        var f1 = { name: 'a.jpg' }, f2 = { name: 'b.jpg' };
        var evt = mkEvt(['Files'], [f1, f2]);
        b.h.handler('drop')(evt);
        assert.equal(b.h.warns.length, 0);
        assert.equal(b.input.files.length, 2);
        assert.equal(b.input.files[0], f1);
        assert.equal(b.input.files[1], f2);
        assert.equal(b.h.dispatches.length, 1);
    });

    it('a drop resets the enter depth: the next drag cycle starts clean', function () {
        var b = bound();
        b.h.handler('dragenter')(mkEvt(['Files']));
        b.h.handler('dragenter')(mkEvt(['Files'])); // depth 2
        b.h.handler('drop')(mkEvt(['Files'], [{ name: 'x.png' }]));
        // a fresh cycle: one enter, one leave — must return to idle (a stale
        // depth from before the drop would keep it stuck on over)
        b.h.handler('dragenter')(mkEvt(['Files']));
        b.h.handler('dragleave')(mkEvt(['Files']));
        assert.equal(b.$z.getAttribute('data-gina-upload-dropzone-state'), 'idle');
    });
});


describe('#R8s2 §05 — scope lock: pure plumbing, no pipeline duplication, no wording', function () {

    it('the bind function never touches the staging machinery (reuse-only design)', function () {
        var fnText = extractFunctionExpression(SRC, BIND_DECL);
        var active = stripComments(fnText);
        ['FormData', '.send(', 'XMLHttpRequest', 'customFiles', 'uploadProperties'].forEach(function (token) {
            assert.ok(active.indexOf(token) < 0,
                'bindUploadDropzone must not carry: ' + token);
        });
    });

    it('neither helper hardcodes any wording (labels are the consumer concern)', function () {
        [BIND_DECL, STATE_DECL].forEach(function (decl) {
            var active = stripComments(extractFunctionExpression(SRC, decl));
            assert.ok(active.indexOf('textContent') < 0, decl + ' never writes text');
            assert.ok(active.indexOf('innerHTML') < 0, decl + ' never writes markup');
        });
    });

    it('every user-facing warn literal is ASCII-only (dist-pin safety)', function () {
        var fnText = extractFunctionExpression(SRC, BIND_DECL);
        var literals = fnText.match(/'[^'\n]*'/g) || [];
        literals.forEach(function (lit) {
            assert.match(lit, /^[\x20-\x7E]*$/,
                'non-ASCII in a string literal risks Closure escaping it in the bundle: ' + lit);
        });
    });
});


describe('#R8s2 §06 — dist fidelity: the built bundles carry the feature', function () {
    // Expected RED before the prod bundle rebuild and green after — the
    // transition is the subtract control proving these detect a stale
    // artifact. All pinned tokens are attribute string literals (they survive
    // Closure SIMPLE mode) and ASCII-only. `data-gina-upload-dropzone` is a
    // strict prefix of its -state sibling, so its distinct presence is pinned
    // by OCCURRENCE COUNT (marker set + owner get + state writes ≥ 3), not a
    // bare indexOf.

    /**
     * Counts occurrences of a token (split-count — grep -c counts lines and
     * the minified bundle is near-single-line).
     *
     * @param {string} haystack
     * @param {string} token
     * @returns {number}
     */
    function occurrences(haystack, token) {
        return haystack.split(token).length - 1;
    }

    ['gina.js', 'gina.min.js'].forEach(function (artifact) {
        it(artifact + ' carries the dropzone attribute literals', function () {
            var bundle = fs.readFileSync(artifact === 'gina.js' ? DIST : DIST_MIN, 'utf8');
            assert.ok(occurrences(bundle, 'data-gina-form-upload-dropzone') >= 3,
                'declarative attribute read at bind + create-only resolution + reset/delete strip');
            assert.ok(occurrences(bundle, 'data-gina-upload-dropzone-state') >= 1,
                'the state hook literal is present');
            assert.ok(occurrences(bundle, 'data-gina-upload-dropzone') >
                      occurrences(bundle, 'data-gina-upload-dropzone-state'),
                'the bare marker literal exists beyond its -state extension');
        });
    });
});
