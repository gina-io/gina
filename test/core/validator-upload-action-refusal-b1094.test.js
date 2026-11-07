'use strict';
/**
 * #B1094 — a staged file input with no staging action refuses a selection before any request.
 *
 * Every <input type="file"> of a bound form gets the staging binding. At bind, checkUploadUrlActions
 * fills a missing `data-gina-form-upload-action` from the `upload-to-tmp-xml` route; with no such
 * route the attribute stays absent, and the change listener went ahead anyway: it set the selection
 * pending (the submit gate counted it as held) and built the virtual form with no action, which
 * posted the file to `/null` (a 404, reported as a failed staging). Since the fix the listener calls
 * refuseStagedSelection right after its empty-selection return: no request, the `uploadNotSent`
 * message in the input's error slot and the form's live region, the input's on-error callback with
 * `{ refused: true, reason: 'action', … }`, the dropzone idle, the input emptied once the `change`
 * dispatch is over, the files it already held left as they were.
 *
 * Layers:
 *   01 source pins (comment-stripped): the listener calls the helper once, right after its
 *      empty-selection return and before its pending write; the helper is declared once and writes
 *      no record of the input; the label lives in A11Y_LABELS and is resolved through a11yLabel
 *   02 the SHIPPED refuseStagedSelection, extracted, driven in a jsdom window with the shipped
 *      a11yLabel, A11Y_LABELS and updateUploadDropzoneState
 *   03 dist fidelity: gina.js carries the same lines; gina.min.js calls the helper between the
 *      listener's empty-selection return and its pending write, and carries the label
 *  The browser path end to end is test/e2e/validator-upload-action-refusal-b1094.spec.js.
 *
 * Seams for a red-first run against PRE-fix bytes without touching the shared tree:
 * B1094_VALIDATOR_SRC=<copy of main.js>, B1094_PLUGIN_DIST=<dir holding js/>.
 *
 * Run: node --test test/core/validator-upload-action-refusal-b1094.test.js
 */

var describe = require('node:test').describe;
var it       = require('node:test').it;
var assert   = require('node:assert/strict');
var fs       = require('fs');
var path     = require('path');
var jsdom    = require('jsdom');

var FW = require('../fw');

var MAIN     = process.env.B1094_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.B1094_PLUGIN_DIST   || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');

// the change listener: its empty-selection return, the refusal, its pending write
var RETURN  = 'if (!files.length ) return false;';
var CALL    = 'if ( refuseStagedSelection($el, files) ) return;';
var PENDING = '$el.pendingFiles = Array.from(files);';

// the declarations the extraction reads (module level: four spaces)
var REFUSE_DECL = '\n    var refuseStagedSelection = function($el, files) {';
var LABEL_DECL  = '\n    var a11yLabel = function(key) {';
var LABELS_DECL = '\n    var A11Y_LABELS = {';
var ZONE_DECL   = '\n    var updateUploadDropzoneState = function(dropzoneId, state) {';

var LABEL_RESOLVE = "a11yLabel('uploadNotSent')";
var LABEL_ENTRY   = /uploadNotSent\s*:\s*'%s was not uploaded'/;

// the minified listener: the return, the call with the listener's input and files, the pending write
// (`if(X(el,f))return;` or, once Closure folds the bare return into the block it guards, `if(!X(el,f)){`)
var MIN_CALL  = /\.length\)\s*return\s*!1\s*;\s*if\s*\(\s*!?\s*([\w$]+)\s*\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*\)\s*(?:return\s*;|\{)\s*\2\s*\.\s*pendingFiles\s*=\s*Array\.from\(\s*\3\s*\)/g;
var MIN_LABEL = /uploadNotSent\s*:\s*(['"])%s was not uploaded\1/g;
var MIN_RESULT = /refused\s*:\s*!0\s*,\s*reason\s*:\s*(['"])action\1/g;

/**
 * Counts the occurrences of a needle.
 *
 * @inner
 * @param {string} hay - the text
 * @param {string} needle - what to count
 * @returns {number} the count
 */
function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The keywords after which an expression starts, so a `/` that follows one opens a regex literal.
 *
 * @constant
 * @type {Array<string>}
 */
var REGEX_KEYWORDS = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'];

/**
 * Whether a `/` met after the code read so far opens a regex literal: the code ends with nothing,
 * an operator, a punctuator, or a keyword after which an expression starts. Anything else makes
 * the `/` a division.
 *
 * @inner
 * @param {string} out - the code read so far, comments dropped
 * @returns {boolean} true for a regex literal
 */
function regexMayStart(out) {
    var j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) { j--; }
    if (j < 0) { return true; }
    if ('(,=:[!&|?{};+-*%<>~^'.indexOf(out[j]) > -1) { return true; }
    if (!/[A-Za-z0-9_$]/.test(out[j])) { return false; }
    var k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) { k--; }
    return REGEX_KEYWORDS.indexOf(out.slice(k + 1, j + 1)) > -1;
}

/**
 * Drops `//` line comments and `/* *\/` block comments outside string, template and regex
 * literals, so a `was:` line or a JSDoc naming a pinned expression cannot satisfy a pin. A regex
 * literal is copied as it is.
 *
 * @inner
 * @param {string} text - the source
 * @returns {string} the source without its comments
 */
function stripComments(text) {
    var out = '', i = 0, n = text.length, quote = null;
    while (i < n) {
        var c = text[i], d = text[i + 1];
        if (quote) {
            out += c;
            if (c === '\\') { out += d; i += 2; continue; }
            if (c === quote) { quote = null; }
            i++; continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
        if (c === '/' && d === '/') { var e = text.indexOf('\n', i); if (e < 0) { e = n; } i = e; continue; }
        if (c === '/' && d === '*') { var f = text.indexOf('*/', i + 2); assert.ok(f > -1, 'unterminated block comment'); i = f + 2; continue; }
        if (c === '/' && regexMayStart(out)) {
            var inClass = false;
            out += c; i++;
            while (i < n) {
                var r = text[i];
                assert.ok(r !== '\n', 'unterminated regex literal');
                out += r;
                if (r === '\\') { out += text[i + 1]; i += 2; continue; }
                i++;
                if (r === '[') { inClass = true; }
                else if (r === ']') { inClass = false; }
                else if (r === '/' && !inClass) { break; }
            }
            continue;
        }
        out += c; i++;
    }
    return out;
}

/**
 * The expression a module-level `var <name> = <expression>` declares, cut from the comment-stripped
 * code: from the `=` to the brace that closes the first one opened after it. The declaration must
 * occur exactly once, and the braces must balance (none of the cut expressions holds a brace inside
 * a string or a regex literal).
 *
 * @inner
 * @param {string} code - the comment-stripped source
 * @param {string} decl - the declaration, from its leading newline to its opening brace
 * @param {string} label - names the text in the messages
 * @returns {string} the expression (`function(…) { … }` or `{ … }`)
 */
function cutExpression(code, decl, label) {
    var at = code.indexOf(decl);
    assert.ok(at > -1, label + ': the declaration ' + JSON.stringify(decl.trim()));
    assert.equal(code.indexOf(decl, at + 1), -1, label + ': the declaration occurs once: ' + JSON.stringify(decl.trim()));
    var eq = code.indexOf('=', at);
    var depth = 0, started = false;
    for (var i = eq; i < code.length; i++) {
        var c = code[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') {
            depth--;
            if (started && depth === 0) { return code.slice(eq + 1, i + 1).trim(); }
        }
    }
    return assert.fail(label + ': unbalanced braces after ' + JSON.stringify(decl.trim()));
}

/**
 * Asserts the listener's lines in a text: the empty-selection return, then the refusal, then the
 * pending write, each once, with nothing but white space between the return and the refusal.
 *
 * @inner
 * @param {string} code - the comment-stripped text
 * @param {string} label - names the text in the messages
 * @returns {void}
 */
function assertListener(code, label) {
    assert.equal(count(code, RETURN), 1, label + ': the empty-selection return');
    assert.equal(count(code, CALL), 1, label + ': the refusal, called once');
    assert.equal(count(code, PENDING), 1, label + ': the pending write');
    var ret = code.indexOf(RETURN), call = code.indexOf(CALL), pending = code.indexOf(PENDING);
    assert.ok(ret < call && call < pending, label + ': the return, the refusal, then the pending write');
    assert.equal(code.slice(ret + RETURN.length, call).trim(), '', label + ': the refusal comes right after the return');
}

var SRC  = fs.readFileSync(MAIN, 'utf8');
var CODE = stripComments(SRC);

/**
 * A jsdom page holding a form, a staged file input and a dropzone, and the shipped
 * refuseStagedSelection compiled against it. jsdom has no FileList constructor, so the input's
 * `files` and `value` are stubbed: `files` returns the selection held, and writing `''` to `value`
 * empties it (recorded in `held.values`).
 *
 * @inner
 * @param {object} [opts]
 * @param {string} [opts.attrs] - attributes added to the file input
 * @param {boolean} [opts.slot] - false: no `#doc-error` element
 * @param {Array<string>} [opts.names] - the names of the selected files (default `['a.png']`)
 * @param {object} [opts.a11y] - `gina.config.a11y`
 * @param {boolean} [opts.dev] - envIsDev (default true)
 * @returns {object} `{ win, doc, $el, held, log, files, refuse }`
 */
function world(opts) {
    opts = opts || {};
    var vc = new jsdom.VirtualConsole();
    var log = { announce: [], fadeIn: [], warn: [], error: [], jsdomErrors: [], calls: [] };
    vc.on('jsdomError', function (e) { log.jsdomErrors.push(String((e && e.message) || e)); });
    var html = '<!DOCTYPE html><html><body>'
        + '<form id="profile"><input type="file" id="doc" name="doc"' + (opts.attrs || '') + '>'
        + ( (opts.slot === false) ? '' : '<div id="doc-error"></div>' )
        + '<div id="other-error"></div></form>'
        + '<div id="zone" data-gina-upload-dropzone-state="dropped"></div></body></html>';
    var dom = new jsdom.JSDOM(html, { virtualConsole: vc });
    var win = dom.window, doc = win.document;
    var $el = doc.getElementById('doc');
    var names = opts.names || ['a.png'];
    var held = { list: names.map(function (n) { return new win.File(['x'], n, { type: 'image/png' }); }), values: [] };
    Object.defineProperty($el, 'files', { configurable: true, get: function () { return held.list; } });
    Object.defineProperty($el, 'value', { configurable: true,
        get: function () { return held.list.length ? 'C:\\fakepath\\' + held.list[0].name : ''; },
        set: function (v) { held.values.push(v); if (v === '') { held.list = []; } } });
    $el.customFiles = ['held-before'];
    var gina = { config: {} };
    if (opts.a11y) { gina.config.a11y = opts.a11y; }
    var labels = new Function('return (' + cutExpression(CODE, LABELS_DECL, 'A11Y_LABELS') + ');')();
    var a11yLabel = new Function('gina', 'A11Y_LABELS', 'return (' + cutExpression(CODE, LABEL_DECL, 'a11yLabel') + ');')(gina, labels);
    var zoneState = new Function('document', 'return (' + cutExpression(CODE, ZONE_DECL, 'updateUploadDropzoneState') + ');')(doc);
    var consoleStub = {
        warn  : function (m) { log.warn.push(String(m)); },
        error : function (m) { log.error.push(String(m)); }
    };
    var refuse = new Function('window', 'document', 'CustomEvent', 'setTimeout', 'console', 'envIsDev', 'a11yLabel',
        'announceA11yError', 'fadeIn', 'updateUploadDropzoneState',
        'return (' + cutExpression(CODE, REFUSE_DECL, 'refuseStagedSelection') + ');')(
        win, doc, win.CustomEvent, setTimeout, consoleStub, opts.dev !== false, a11yLabel,
        function ($form, text) { log.announce.push({ form: $form, text: text }); return null; },
        function (el) { log.fadeIn.push(el.id); el.style.display = 'block'; },
        zoneState);
    return { win: win, doc: doc, $el: $el, held: held, log: log, files: held.list, refuse: refuse, labels: labels };
}

/**
 * Waits for the timers queued so far to run.
 *
 * @inner
 * @returns {Promise<void>}
 */
function tick() { return new Promise(function (resolve) { setTimeout(resolve, 5); }); }

/**
 * Records the input's on-error callback under a window name.
 *
 * @inner
 * @param {object} w - the world
 * @param {string} name - the window name
 * @param {function} [body] - run inside the callback
 * @returns {void}
 */
function callback(w, name, body) {
    w.win[name] = function (event, data) {
        w.log.calls.push({ event: event, data: data });
        if (body) { body(event, data); }
    };
}

var ZONE   = ' data-gina-form-upload-dropzone="zone"';
var ON_ERR = ' data-gina-form-upload-on-error="onDocError"';

describe('#B1094 - a staged input with no staging action refuses a selection before any request', function () {

    describe('01 - source pins (comment-stripped)', function () {
        it('01.1 - the change listener calls the refusal right after its empty-selection return, before its pending write', function () {
            assertListener(CODE, 'src');
        });

        it('01.2 - the helper is declared once at module level and writes no record of the input', function () {
            var fn = cutExpression(CODE, REFUSE_DECL, 'src');
            assert.equal(count(fn, 'pendingFiles'), 0, 'the refusal sets no pending selection');
            assert.equal(count(fn, 'customFiles'), 0, 'the refusal touches no held entry');
            assert.equal(count(fn, 'resyncStagedUploadGate'), 0, 'the submit gate is not re-synced: nothing it reads changed');
            assert.equal(count(fn, "reason          : 'action'"), 1, 'the reason');
        });

        it('01.3 - the label lives in A11Y_LABELS and is resolved through a11yLabel', function () {
            assert.match(cutExpression(CODE, LABELS_DECL, 'src'), LABEL_ENTRY);
            assert.equal(count(CODE, LABEL_RESOLVE), 1, 'resolved once, in the refusal');
        });

        it('[instrument] the raw source carries the anchors the stripped reads count, and the stripper drops comments', function () {
            assert.ok(count(SRC, RETURN) >= 1 && count(SRC, PENDING) >= 1, 'the listener anchors are in the raw source');
            assert.ok(count(SRC, '// was:') > 0, 'the raw source holds was: lines');
            assert.equal(count(CODE, '// was:'), 0, 'no was: line survives the stripper');
        });
    });

    describe('02 - the shipped refuseStagedSelection, in a jsdom page', function () {
        it('02.1 - no action: refused; the message in the slot and announced, the callback, the zone idle, the input emptied after the dispatch', async function () {
            var w = world({ attrs: ZONE + ON_ERR });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true, 'refused');
            var slot = w.doc.getElementById('doc-error');
            assert.equal(slot.getElementsByTagName('p').length, 1, 'one message in the slot');
            assert.equal(slot.textContent, 'a.png was not uploaded');
            assert.deepEqual(w.log.fadeIn, ['doc-error'], 'the slot is shown');
            assert.equal(w.log.announce.length, 1, 'announced once');
            assert.equal(w.log.announce[0].form, w.doc.getElementById('profile'), 'through the input\'s form');
            assert.equal(w.log.announce[0].text, 'a.png was not uploaded');
            assert.equal(w.doc.getElementById('zone').getAttribute('data-gina-upload-dropzone-state'), 'idle', 'the zone is idle');
            assert.equal(w.log.error.length, 1, 'one dev console error');
            assert.match(w.log.error[0], /data-gina-form-upload-action/, 'it names the attribute');
            assert.equal(w.log.warn.length, 0, 'no warning');
            assert.equal(w.log.calls.length, 1, 'the callback ran once');
            var call = w.log.calls[0];
            assert.deepEqual(JSON.parse(JSON.stringify(call.data)), { refused: true, reason: 'action', files: ['a.png'], error: 'a.png was not uploaded', transportError: false });
            assert.equal(call.event.type, 'error.hform', 'the event a `.on(\'error.hform\')` handler gets');
            assert.equal(call.event.target, w.$el, 'dispatched on the input');
            assert.equal(call.event.bubbles, false, 'it does not bubble');
            assert.equal(call.event.detail, call.data, 'its detail is the result');
            assert.equal(w.held.values.length, 0, 'the input is not emptied during the dispatch');
            assert.equal(w.$el.files.length, 1, 'the listeners after this one still read the selection');
            await tick();
            assert.deepEqual(w.held.values, [''], 'emptied once the dispatch is over');
            assert.equal(w.$el.files.length, 0);
            assert.equal(typeof(w.$el.pendingFiles), 'undefined', 'no pending selection');
            assert.deepEqual(w.$el.customFiles, ['held-before'], 'the files held before are untouched');
            assert.equal(w.log.jsdomErrors.length, 0);
        });

        it('02.2 - CONTROL: with an action, nothing is refused and nothing is written', async function () {
            var w = world({ attrs: ' data-gina-form-upload-action="/stage"' + ZONE + ON_ERR });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), false, 'not refused');
            assert.equal(w.doc.getElementById('doc-error').textContent, '', 'the slot is untouched');
            assert.equal(w.log.announce.length + w.log.fadeIn.length + w.log.warn.length + w.log.error.length + w.log.calls.length, 0, 'no announce, no console, no callback');
            assert.equal(w.doc.getElementById('zone').getAttribute('data-gina-upload-dropzone-state'), 'dropped', 'the zone is left to the staging');
            await tick();
            assert.equal(w.held.values.length, 0, 'the input keeps its selection');
        });

        it('02.3 - an empty action attribute refuses as a missing one does', function () {
            var w = world({ attrs: ' data-gina-form-upload-action=""' });
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.equal(w.doc.getElementById('doc-error').textContent, 'a.png was not uploaded');
        });

        it('02.4 - no slot: announced, a dev warning names the slot, the callback still runs', function () {
            var w = world({ slot: false, attrs: ON_ERR });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.equal(w.log.announce.length, 1);
            assert.equal(w.log.announce[0].text, 'a.png was not uploaded');
            assert.equal(w.log.warn.length, 1);
            assert.match(w.log.warn[0], /#doc-error/, 'the warning names the missing element');
            assert.equal(w.log.calls.length, 1);
        });

        it('02.5 - a slot the input names is written, the default one is left alone', function () {
            var w = world({ attrs: ' data-gina-form-upload-error="other-error"' });
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.equal(w.doc.getElementById('other-error').textContent, 'a.png was not uploaded');
            assert.equal(w.doc.getElementById('doc-error').textContent, '');
        });

        it('02.6 - no declared callback: the virtual form\'s default name runs when the page defines it, and nothing throws when it does not', function () {
            var w = world();
            callback(w, 'onGenericXhrResponse');
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.equal(w.log.calls.length, 1);
            assert.equal(w.log.calls[0].data.reason, 'action');
            var bare = world();
            assert.equal(bare.refuse(bare.$el, bare.files), true, 'no callback to run');
            assert.equal(bare.log.jsdomErrors.length, 0);
        });

        it('02.7 - a function-call shape is not called, and a dev warning names it', function () {
            var w = world({ attrs: ' data-gina-form-upload-on-error="onDocError()"' });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.equal(w.log.calls.length, 0);
            assert.equal(w.log.warn.length, 1);
            assert.match(w.log.warn[0], /onDocError\(\)/);
        });

        it('02.8 - a callback that throws is reported as a listener error and the refusal is complete', async function () {
            var w = world({ attrs: ZONE + ON_ERR });
            callback(w, 'onDocError', function () { throw new Error('page handler failed'); });
            var returned = null;
            assert.doesNotThrow(function () { returned = w.refuse(w.$el, w.files); });
            assert.equal(returned, true);
            assert.equal(w.log.calls.length, 1);
            assert.equal(w.log.jsdomErrors.length, 1, 'reported, not thrown');
            assert.match(w.log.jsdomErrors[0], /page handler failed/);
            assert.equal(w.doc.getElementById('doc-error').textContent, 'a.png was not uploaded');
            assert.equal(w.doc.getElementById('zone').getAttribute('data-gina-upload-dropzone-state'), 'idle');
            await tick();
            assert.deepEqual(w.held.values, ['']);
        });

        it('02.9 - several files: the message and the result name each of them', function () {
            var w = world({ names: ['a.png', 'b.pdf'], attrs: ON_ERR });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.equal(w.doc.getElementById('doc-error').textContent, 'a.png, b.pdf was not uploaded');
            assert.deepEqual(Array.from(w.log.calls[0].data.files), ['a.png', 'b.pdf']);
        });

        it('02.10 - a name holding replacement patterns is written as it is', function () {
            var w = world({ names: ['a$&b$1.png'] });
            w.refuse(w.$el, w.files);
            assert.equal(w.doc.getElementById('doc-error').textContent, 'a$&b$1.png was not uploaded');
        });

        it('02.15 - a name holding markup is written as text, never parsed (#B727)', function () {
            var w = world({ names: ['<img src=x onerror=1>.png'] });
            assert.equal(w.refuse(w.$el, w.files), true);
            var slot = w.doc.getElementById('doc-error');
            assert.equal(slot.getElementsByTagName('img').length, 0, 'no element is built from the name');
            assert.equal(slot.textContent, '<img src=x onerror=1>.png was not uploaded');
        });

        it('02.11 - gina.config.a11y translates the message, in the slot, the announcement and the result', function () {
            var w = world({ a11y: { uploadNotSent: '%s n\'a pas été envoyé' }, attrs: ON_ERR });
            callback(w, 'onDocError');
            w.refuse(w.$el, w.files);
            assert.equal(w.doc.getElementById('doc-error').textContent, 'a.png n\'a pas été envoyé');
            assert.equal(w.log.announce[0].text, 'a.png n\'a pas été envoyé');
            assert.equal(w.log.calls[0].data.error, 'a.png n\'a pas été envoyé');
        });

        it('02.12 - a newer selection made before the timer runs is left on the input', async function () {
            var w = world();
            w.refuse(w.$el, w.files);
            w.held.list = [new w.win.File(['y'], 'c.png', { type: 'image/png' })];
            await tick();
            assert.equal(w.held.values.length, 0, 'not emptied');
            assert.equal(w.$el.files[0].name, 'c.png');
        });

        it('02.13 - outside dev mode, no console line, even without a slot', function () {
            var w = world({ slot: false, dev: false });
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.equal(w.log.warn.length + w.log.error.length, 0);
            assert.equal(w.log.announce.length, 1, 'still announced');
        });

        it('02.14 - the shipped English default', function () {
            var w = world();
            assert.equal(w.labels.uploadNotSent, '%s was not uploaded');
        });
    });

    describe('03 - dist fidelity', function () {
        it('03.1 - the unminified bundle carries the listener\'s lines and the helper', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            assertListener(raw, 'gina.js');
            assert.match(cutExpression(raw, LABELS_DECL, 'gina.js'), LABEL_ENTRY);
            assert.equal(count(cutExpression(raw, REFUSE_DECL, 'gina.js'), "reason          : 'action'"), 1);
        });

        it('03.2 - the minified listener calls the refusal with its input and files, between its return and its pending write', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal((min.match(MIN_CALL) || []).length, 1, 'the call, once');
            assert.equal((min.match(MIN_LABEL) || []).length, 1, 'the label');
            assert.equal((min.match(MIN_RESULT) || []).length, 1, 'the result\'s reason');
        });

        it('[instrument] the minified bundle still carries the pending write the pin above extends', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal(count(min, '.pendingFiles=Array.from('), 1);
        });
    });
});
