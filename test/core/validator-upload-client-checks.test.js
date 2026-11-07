'use strict';
/**
 * The upload client checks: a staged file input's `accept` and `data-gina-form-upload-max-size`
 * refuse a selection before any request.
 *
 * A staged file input used to send every file it was given, whatever its `accept` said: the
 * browser's picker only filters what it shows (a user can choose « All files »), a drop is not
 * filtered at all, and the server was the only check. refuseStagedSelection, which the change
 * listener calls right after its empty-selection return (#B1094), now also refuses, before the file
 * counts as held and before any request, a selection holding a file whose type `accept` excludes or
 * whose size is over `data-gina-form-upload-max-size`. The whole selection is refused; the message
 * names the refused files, one line per reason (`uploadTypeRefused`, then `uploadSizeRefused`); the
 * on-error callback gets `{ refused: true, reason: 'type'|'size', files, error, transportError: false }`.
 * The server stays the authority: the checks only spare a request.
 *
 * Layers:
 *   01 source pins (comment-stripped): one call in the listener (the #B959 window), the two labels
 *      and their resolution, the size grammar read against the server's own, the action checked first
 *   02 the SHIPPED refuseStagedSelection, extracted, driven in a jsdom window with the shipped
 *      a11yLabel, A11Y_LABELS and updateUploadDropzoneState: D1–D4 of the design, its four rulings
 *      on the strings, both reasons, a staging in flight and invalid tokens, and controls
 *   03 dist fidelity: gina.js carries the same helper and labels; gina.min.js the labels, the grammar
 *      and the one call
 *  The browser path end to end (a drop and a pick) is test/e2e/validator-upload-client-checks.spec.js.
 *
 * Seams for a red-first run against other bytes without touching the shared tree:
 * UPCHECKS_VALIDATOR_SRC=<copy of main.js>, UPCHECKS_PLUGIN_DIST=<dir holding js/>.
 *
 * Run: node --test test/core/validator-upload-client-checks.test.js
 */

var describe = require('node:test').describe;
var it       = require('node:test').it;
var assert   = require('node:assert/strict');
var fs       = require('fs');
var path     = require('path');
var jsdom    = require('jsdom');

var FW = require('../fw');

var MAIN     = process.env.UPCHECKS_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST     = process.env.UPCHECKS_PLUGIN_DIST   || path.join(FW, 'core/asset/plugin/dist/vendor/gina');
var DIST_RAW = path.join(DIST, 'js/gina.js');
var DIST_MIN = path.join(DIST, 'js/gina.min.js');
var SERVER   = path.join(FW, 'core/server.js');

// the change listener: its empty-selection return, the refusal, its pending write
var RETURN  = 'if (!files.length ) return false;';
var CALL    = 'if ( refuseStagedSelection($el, files) ) return;';
var PENDING = '$el.pendingFiles = Array.from(files);';

// the declarations the extraction reads (module level: four spaces)
var REFUSE_DECL = '\n    var refuseStagedSelection = function($el, files) {';
var LABEL_DECL  = '\n    var a11yLabel = function(key) {';
var LABELS_DECL = '\n    var A11Y_LABELS = {';
var ZONE_DECL   = '\n    var updateUploadDropzoneState = function(dropzoneId, state) {';

var TYPE_TEXT = '%s was not uploaded: this type of file is not accepted';
var SIZE_TEXT = '%s was not uploaded: the file is too large';

// the size grammar, as the server writes it in parseSize (core/server.js)
var GRAMMAR = '/^([0-9]*\\.?[0-9]+)\\s*(b|kb|k|mb|m|gb|g)?$/i';

var MB = 1024 * 1024;
var GB = 1024 * MB;

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

var SRC  = fs.readFileSync(MAIN, 'utf8');
var CODE = stripComments(SRC);

/**
 * A jsdom page holding a form, a staged file input and a dropzone, and the shipped
 * refuseStagedSelection compiled against it. The selection is a list of plain `{ name, type, size }`
 * records, which is all the helper reads of a file (so a size of several gigabytes needs no
 * buffer); the input's `files` returns the list held, and writing `''` to its `value` empties it
 * (recorded in `held.values`). The input has a staging action unless `opts.action` is false, so the
 * client checks are reached.
 *
 * @inner
 * @param {object} [opts]
 * @param {string} [opts.attrs] - attributes added to the file input
 * @param {boolean} [opts.action] - false: no `data-gina-form-upload-action`
 * @param {boolean} [opts.slot] - false: no `#doc-error` element
 * @param {Array<object>} [opts.files] - the selected files, `{ name, type, size }` (default one PNG)
 * @param {object} [opts.a11y] - `gina.config.a11y`
 * @param {boolean} [opts.dev] - envIsDev (default true)
 * @returns {object} `{ win, doc, $el, held, log, files, refuse, labels }`
 */
function world(opts) {
    opts = opts || {};
    var vc = new jsdom.VirtualConsole();
    var log = { announce: [], fadeIn: [], warn: [], error: [], jsdomErrors: [], calls: [] };
    vc.on('jsdomError', function (e) { log.jsdomErrors.push(String((e && e.message) || e)); });
    var html = '<!DOCTYPE html><html><body>'
        + '<form id="profile"><input type="file" id="doc" name="doc"'
        + ( (opts.action === false) ? '' : ' data-gina-form-upload-action="/stage"' )
        + (opts.attrs || '') + '>'
        + ( (opts.slot === false) ? '' : '<div id="doc-error"></div>' )
        + '</form>'
        + '<div id="zone" data-gina-upload-dropzone-state="dropped"></div></body></html>';
    var dom = new jsdom.JSDOM(html, { virtualConsole: vc });
    var win = dom.window, doc = win.document;
    var $el = doc.getElementById('doc');
    var held = { list: (opts.files || [{ name: 'a.png', type: 'image/png', size: 10 }]).slice(), values: [] };
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
 * @returns {void}
 */
function callback(w, name) {
    w.win[name] = function (event, data) {
        w.log.calls.push({ event: event, data: JSON.parse(JSON.stringify(data)) });
    };
}

/**
 * One file record.
 *
 * @inner
 * @param {string} name - the file name
 * @param {string} [type] - its type, '' when omitted
 * @param {number} [size] - its size in bytes, 10 when omitted
 * @returns {{name: string, type: string, size: number}}
 */
function file(name, type, size) { return { name: name, type: type || '', size: (typeof(size) == 'number') ? size : 10 }; }

/**
 * Whether the helper refuses one file under the given attributes (a fresh world each call).
 *
 * @inner
 * @param {string} attrs - the input's attributes
 * @param {object} f - the file record
 * @param {object} [opts] - more world options
 * @returns {boolean} true when refused
 */
function refuses(attrs, f, opts) {
    var w = world(Object.assign({ attrs: attrs, files: [f] }, opts || {}));
    return w.refuse(w.$el, w.files);
}

/**
 * The text of each paragraph of the input's error slot.
 *
 * @inner
 * @param {object} w - the world
 * @returns {Array<string>} the lines
 */
function slotLines(w) {
    return Array.prototype.map.call(w.doc.getElementById('doc-error').getElementsByTagName('p'), function (p) { return p.textContent; });
}

var ZONE   = ' data-gina-form-upload-dropzone="zone"';
var ON_ERR = ' data-gina-form-upload-on-error="onDocError"';

describe('upload client checks - a staged input\'s accept and max size refuse a selection before any request', function () {

    describe('01 - source pins (comment-stripped)', function () {
        it('01.1 - the change listener still calls the refusal once, right after its empty-selection return, before its pending write', function () {
            assert.equal(count(CODE, RETURN), 1, 'the empty-selection return');
            assert.equal(count(CODE, CALL), 1, 'one call: the checks live inside the helper');
            assert.equal(count(CODE, 'refuseStagedSelection('), 1, 'no other call site');
            var ret = CODE.indexOf(RETURN), call = CODE.indexOf(CALL), pending = CODE.indexOf(PENDING);
            assert.ok(ret < call && call < pending, 'the return, the refusal, then the pending write');
            assert.equal(CODE.slice(ret + RETURN.length, call).trim(), '', 'the refusal comes right after the return');
        });

        it('01.2 - the two labels live in A11Y_LABELS with the ruled wording, and each is resolved once, in the helper', function () {
            var labels = cutExpression(CODE, LABELS_DECL, 'src');
            assert.match(labels, /uploadTypeRefused\s*:\s*'%s was not uploaded: this type of file is not accepted'/);
            assert.match(labels, /uploadSizeRefused\s*:\s*'%s was not uploaded: the file is too large'/);
            var fn = cutExpression(CODE, REFUSE_DECL, 'src');
            ['uploadTypeRefused', 'uploadSizeRefused'].forEach(function (k) {
                assert.equal(count(CODE, "a11yLabel('" + k + "')"), 1, k + ': resolved once');
                assert.equal(count(fn, "a11yLabel('" + k + "')"), 1, k + ': in the helper');
            });
        });

        it('01.3 - the size attribute is read with the server\'s own grammar for upload.maxFieldsSize', function () {
            var server = stripComments(fs.readFileSync(SERVER, 'utf8'));
            assert.ok(count(server, '.match(' + GRAMMAR + ')') >= 1, 'the server\'s parseSize uses the grammar');
            var fn = cutExpression(CODE, REFUSE_DECL, 'src');
            assert.equal(count(fn, '.match(' + GRAMMAR + ')'), 1, 'the helper uses the same grammar');
            assert.equal(count(fn, "getAttribute('data-gina-form-upload-max-size')"), 1, 'the size attribute, read once');
            assert.equal(count(fn, "getAttribute('accept')"), 1, 'the accept attribute, read once');
        });

        it('01.4 - the staging action is checked before the client checks', function () {
            var fn = cutExpression(CODE, REFUSE_DECL, 'src');
            var action = fn.indexOf("getAttribute('data-gina-form-upload-action')");
            var accept = fn.indexOf("getAttribute('accept')");
            assert.ok(action > -1 && accept > -1, 'both reads');
            assert.ok(action < accept, 'the action first');
            assert.equal(count(fn, 'pendingFiles') + count(fn, 'customFiles') + count(fn, 'resyncStagedUploadGate'), 0,
                'the helper writes no record of the input');
        });

        it('[instrument] the raw source carries the anchors the stripped reads count, and the stripper drops comments', function () {
            assert.ok(count(SRC, RETURN) >= 1 && count(SRC, PENDING) >= 1, 'the listener anchors are in the raw source');
            assert.ok(count(SRC, '// was:') > 0, 'the raw source holds was: lines');
            assert.equal(count(CODE, '// was:'), 0, 'no was: line survives the stripper');
            assert.ok(count(SRC, 'refuseStagedSelection') > count(CODE, 'refuseStagedSelection'),
                'the raw source names the helper in comments too, which the stripped reads do not count');
        });
    });

    describe('02 - the shipped refuseStagedSelection, in a jsdom page', function () {
        it('02.1 - D1: a file whose type `accept` excludes is refused: the line in the slot and announced, the callback, the zone idle, the input emptied after the dispatch', async function () {
            var w = world({ attrs: ' accept=".pdf"' + ZONE + ON_ERR, files: [file('a.png', 'image/png')] });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true, 'refused');
            assert.deepEqual(slotLines(w), ['a.png was not uploaded: this type of file is not accepted']);
            assert.deepEqual(w.log.fadeIn, ['doc-error'], 'the slot is shown');
            assert.equal(w.log.announce.length, 1, 'announced once');
            assert.equal(w.log.announce[0].form, w.doc.getElementById('profile'), 'through the input\'s form');
            assert.equal(w.log.announce[0].text, 'a.png was not uploaded: this type of file is not accepted');
            assert.equal(w.doc.getElementById('zone').getAttribute('data-gina-upload-dropzone-state'), 'idle', 'the zone is idle');
            assert.equal(w.log.error.length, 1, 'one dev console error');
            assert.match(w.log.error[0], /`accept`/, 'it names the attribute');
            assert.doesNotMatch(w.log.error[0], /max-size/, 'and only that one');
            assert.equal(w.log.warn.length, 0, 'no warning');
            assert.equal(w.log.calls.length, 1, 'the callback ran once');
            assert.deepEqual(w.log.calls[0].data, { refused: true, reason: 'type', files: ['a.png'], error: 'a.png was not uploaded: this type of file is not accepted', transportError: false });
            assert.equal(w.log.calls[0].event.type, 'error.hform');
            assert.equal(w.log.calls[0].event.target, w.$el, 'dispatched on the input');
            assert.equal(w.log.calls[0].event.bubbles, false, 'it does not bubble');
            assert.equal(w.held.values.length, 0, 'the input is not emptied during the dispatch');
            await tick();
            assert.deepEqual(w.held.values, [''], 'emptied once the dispatch is over');
            assert.equal(typeof(w.$el.pendingFiles), 'undefined', 'no pending selection');
            assert.deepEqual(w.$el.customFiles, ['held-before'], 'the files held before are untouched');
            assert.equal(w.log.jsdomErrors.length, 0);
        });

        it('02.2 - CONTROL: a file `accept` matches is left to the staging: nothing refused, nothing written', async function () {
            var w = world({ attrs: ' accept=".pdf" data-gina-form-upload-max-size="1MB"' + ZONE + ON_ERR, files: [file('a.pdf', 'application/pdf', 100)] });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), false, 'not refused');
            assert.equal(w.doc.getElementById('doc-error').textContent, '', 'the slot is untouched');
            assert.equal(w.log.announce.length + w.log.fadeIn.length + w.log.warn.length + w.log.error.length + w.log.calls.length, 0, 'no announce, no console, no callback');
            assert.equal(w.doc.getElementById('zone').getAttribute('data-gina-upload-dropzone-state'), 'dropped', 'the zone is left to the staging');
            await tick();
            assert.equal(w.held.values.length, 0, 'the input keeps its selection');
        });

        it('02.3 - CONTROL: an input with neither attribute refuses nothing and logs nothing', function () {
            var w = world({ files: [file('a.exe', 'application/x-msdownload', 5 * GB)] });
            assert.equal(w.refuse(w.$el, w.files), false);
            assert.equal(w.log.warn.length + w.log.error.length + w.log.announce.length, 0);
        });

        it('02.4 - D2: a selection holding one refused file is refused whole, and only the refused file is named', function () {
            var w = world({ attrs: ' multiple accept=".pdf"' + ON_ERR, files: [file('a.pdf', 'application/pdf'), file('b.png', 'image/png'), file('c.pdf', 'application/pdf')] });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true, 'refused: the listener stages nothing of it');
            assert.deepEqual(slotLines(w), ['b.png was not uploaded: this type of file is not accepted']);
            assert.deepEqual(w.log.calls[0].data.files, ['b.png']);
            var two = world({ attrs: ' multiple accept=".pdf"' + ON_ERR, files: [file('b.png', 'image/png'), file('a.pdf', 'application/pdf'), file('d.gif', 'image/gif')] });
            callback(two, 'onDocError');
            assert.equal(two.refuse(two.$el, two.files), true);
            assert.deepEqual(slotLines(two), ['b.png, d.gif was not uploaded: this type of file is not accepted'], 'one line naming each refused file, in selection order');
            assert.deepEqual(two.log.calls[0].data.files, ['b.png', 'd.gif']);
        });

        it('02.5 - D3: the size grammar is the server\'s: units b, k/kb, m/mb, g/gb in any case, 1024-based, a bare number in MB, white space allowed, the limit itself allowed', function () {
            var table = [
                // [attribute value, size in bytes, refused]
                ['1KB',    1024,           false], ['1KB',    1025,           true],
                ['1kb',    1025,           true],  ['1k',     1024,           false], ['1K',  1025, true],
                ['1 KB',   1025,           true],  ['  1k  ', 1025,           true],
                ['2048b',  2048,           false], ['2048B',  2049,           true],
                ['1',      MB,             false], ['1',      MB + 1,         true],
                ['1mb',    MB + 1,         true],  ['1M',     MB,             false],
                ['1.5MB',  1.5 * MB,       false], ['1.5MB',  1.5 * MB + 1,   true],
                ['.5m',    0.5 * MB,       false], ['.5m',    0.5 * MB + 1,   true],
                ['1g',     GB,             false], ['1GB',    GB + 1,         true],
                ['0.001k', 2,              true],  ['0.001k', 1,              false]
            ];
            table.forEach(function (row) {
                var got = refuses(' data-gina-form-upload-max-size="' + row[0] + '"', file('a.bin', 'application/octet-stream', row[1]));
                assert.equal(got, row[2], JSON.stringify(row[0]) + ' against ' + row[1] + ' bytes');
            });
        });

        it('02.6 - D3: `0` sets no limit, as on the server, and warns about nothing', function () {
            ['0', '0kb', '0.0', ' 0 MB '].forEach(function (v) {
                var w = world({ attrs: ' data-gina-form-upload-max-size="' + v + '"', files: [file('huge.bin', 'application/octet-stream', 5 * GB)] });
                assert.equal(w.refuse(w.$el, w.files), false, JSON.stringify(v));
                assert.equal(w.log.warn.length, 0, JSON.stringify(v) + ': no warning');
            });
        });

        it('02.7 - D3: a value that does not parse checks no size, with a dev warning naming the value; outside dev, no warning', function () {
            ['big', '1TB', '-1', '1.2.3', '1 0', 'MB', '1e3'].forEach(function (v) {
                var w = world({ attrs: ' data-gina-form-upload-max-size="' + v + '"', files: [file('huge.bin', 'application/octet-stream', 5 * GB)] });
                assert.equal(w.refuse(w.$el, w.files), false, JSON.stringify(v) + ': no size checked');
                assert.equal(w.log.warn.length, 1, JSON.stringify(v) + ': one warning');
                assert.ok(w.log.warn[0].indexOf('`' + v + '`') > -1, JSON.stringify(v) + ': the warning names the value');
            });
            var prod = world({ dev: false, attrs: ' data-gina-form-upload-max-size="big"', files: [file('huge.bin', '', 5 * GB)] });
            assert.equal(prod.refuse(prod.$el, prod.files), false);
            assert.equal(prod.log.warn.length + prod.log.error.length, 0);
            var empty = world({ attrs: ' data-gina-form-upload-max-size="  "', files: [file('huge.bin', '', 5 * GB)] });
            assert.equal(empty.refuse(empty.$el, empty.files), false, 'an empty value is no limit');
            assert.equal(empty.log.warn.length, 0, 'and no warning');
        });

        it('02.8 - D4: tokens are split on commas, trimmed and lowercased', function () {
            var attrs = ' accept=" .PDF , IMAGE/PNG ,,"';
            assert.equal(refuses(attrs, file('a.pdf')), false, '.PDF matches a.pdf');
            assert.equal(refuses(attrs, file('b.png', 'image/png')), false, 'IMAGE/PNG matches image/png');
            assert.equal(refuses(attrs, file('c.txt', 'text/plain')), true, 'c.txt matches neither');
            assert.equal(world({ attrs: attrs, files: [file('a.pdf')] }).log.warn.length, 0, 'empty tokens are no invalid tokens');
        });

        it('02.9 - D4: a `.ext` token matches the end of the lowercased name', function () {
            assert.equal(refuses(' accept=".pdf"', file('Report.PDF', 'application/pdf')), false, 'case-insensitive');
            assert.equal(refuses(' accept=".pdf"', file('a.pdf.png', 'image/png')), true, 'the end of the name, not anywhere in it');
            assert.equal(refuses(' accept=".pdf"', file('pdf', '')), true, 'a name with no dot');
            assert.equal(refuses(' accept=".pdf"', file('apdf', '')), true, 'the dot belongs to the token');
            assert.equal(refuses(' accept=".tar.gz"', file('x.tar.gz', 'application/gzip')), false, 'a token with two dots');
            assert.equal(refuses(' accept=".tar.gz"', file('x.gz', 'application/gzip')), true);
        });

        it('02.10 - D4: a `type/*` token matches the start of the lowercased type, never an empty type', function () {
            assert.equal(refuses(' accept="image/*"', file('a.png', 'image/png')), false);
            assert.equal(refuses(' accept="image/*"', file('a.svg', 'image/svg+xml')), false);
            assert.equal(refuses(' accept="image/*"', file('a.png', 'IMAGE/PNG')), false, 'the type lowercased');
            assert.equal(refuses(' accept="image/*"', file('a.pdf', 'application/pdf')), true);
            assert.equal(refuses(' accept="image/*"', file('a.png', 'imagex/png')), true, 'the prefix includes the slash');
            assert.equal(refuses(' accept="image/*"', file('a.png', '')), true, 'an empty type matches no MIME token, even under an image name');
        });

        it('02.11 - D4: any other `type/subtype` token matches the type exactly, and an extension token still matches a file with no type by its name', function () {
            assert.equal(refuses(' accept="application/pdf"', file('a.pdf', 'application/pdf')), false);
            assert.equal(refuses(' accept="application/pdf"', file('a.pdf', 'Application/PDF')), false, 'the type lowercased');
            assert.equal(refuses(' accept="application/pdf"', file('a.pdf', 'application/pdfx')), true, 'exactly, not a prefix');
            assert.equal(refuses(' accept="application/pdf"', file('a.pdf', '')), true, 'an empty type matches no MIME token');
            assert.equal(refuses(' accept="application/pdf,.pdf"', file('a.pdf', '')), false, 'the extension token matches it by name');
        });

        it('02.12 - the reading flagged for review: `*/*` reads « any type », so it refuses only a file with no type', function () {
            assert.equal(refuses(' accept="*/*"', file('a.png', 'image/png')), false);
            assert.equal(refuses(' accept="*/*"', file('a.zip', 'application/zip')), false);
            assert.equal(refuses(' accept="*/*"', file('README', '')), true, 'D4: an empty type matches no MIME token');
            var w = world({ attrs: ' accept="*/*"', files: [file('a.png', 'image/png')] });
            w.refuse(w.$el, w.files);
            assert.equal(w.log.warn.length, 0, 'a valid token');
        });

        it('02.13 - the ruled English defaults', function () {
            var w = world();
            assert.equal(w.labels.uploadTypeRefused, TYPE_TEXT);
            assert.equal(w.labels.uploadSizeRefused, SIZE_TEXT);
            assert.equal(w.labels.uploadNotSent, '%s was not uploaded', 'the #B1094 string is unchanged');
        });

        it('02.14 - both reasons: the type line for its files, then the size line for its files; reason `type`; every refused name', function () {
            var w = world({ attrs: ' multiple accept=".pdf,.png" data-gina-form-upload-max-size="1KB"' + ON_ERR, files: [file('big.pdf', 'application/pdf', 4096), file('a.txt', 'text/plain'), file('ok.png', 'image/png', 1), file('big.png', 'image/png', 2048), file('b.exe', '')] });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true);
            var typeLine = 'a.txt, b.exe was not uploaded: this type of file is not accepted';
            var sizeLine = 'big.pdf, big.png was not uploaded: the file is too large';
            assert.deepEqual(slotLines(w), [typeLine, sizeLine], 'two lines, the type first');
            assert.equal(w.log.announce.length, 1, 'announced together');
            assert.equal(w.log.announce[0].text, typeLine + '. ' + sizeLine);
            assert.deepEqual(w.log.calls[0].data, { refused: true, reason: 'type', files: ['a.txt', 'b.exe', 'big.pdf', 'big.png'], error: typeLine + '. ' + sizeLine, transportError: false });
            assert.match(w.log.error[0], /`accept` and `data-gina-form-upload-max-size`/, 'the dev error names both attributes');
        });

        it('02.15 - the type first: a file refused for its type is not checked for its size', function () {
            var w = world({ attrs: ' accept=".pdf" data-gina-form-upload-max-size="1KB"' + ON_ERR, files: [file('huge.png', 'image/png', 5 * MB)] });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.deepEqual(slotLines(w), ['huge.png was not uploaded: this type of file is not accepted'], 'the type line only');
            assert.deepEqual(w.log.calls[0].data.files, ['huge.png'], 'named once');
            assert.equal(w.log.calls[0].data.reason, 'type');
        });

        it('02.16 - size only: reason `size`, the size line, the attribute named', function () {
            var w = world({ attrs: ' accept=".pdf" data-gina-form-upload-max-size="1KB"' + ON_ERR, files: [file('big.pdf', 'application/pdf', 1025)] });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.deepEqual(slotLines(w), ['big.pdf was not uploaded: the file is too large']);
            assert.deepEqual(w.log.calls[0].data, { refused: true, reason: 'size', files: ['big.pdf'], error: 'big.pdf was not uploaded: the file is too large', transportError: false });
            assert.match(w.log.error[0], /`data-gina-form-upload-max-size`/);
            assert.doesNotMatch(w.log.error[0], /`accept`/);
        });

        it('02.17 - a staging of the input\'s earlier selection still in flight is left to finish: its pending files and the held entries are untouched', async function () {
            var w = world({ attrs: ' accept=".pdf"', files: [file('b.png', 'image/png')] });
            var inFlight = [file('a.pdf', 'application/pdf')];
            w.$el.pendingFiles = inFlight;
            assert.equal(w.refuse(w.$el, w.files), true);
            await tick();
            assert.equal(w.$el.pendingFiles, inFlight, 'the same pending list');
            assert.deepEqual(w.$el.pendingFiles.map(function (f) { return f.name; }), ['a.pdf'], 'with the same file');
            assert.deepEqual(w.$el.customFiles, ['held-before']);
        });

        it('02.18 - invalid `accept` tokens are ignored, with one dev warning naming them; an `accept` with no valid token checks no type', function () {
            var attrs = ' accept="jpg, image/png;q=1, .pdf, image/, /png, image"';
            var w = world({ attrs: attrs, files: [file('a.png', 'image/png')] });
            assert.equal(w.refuse(w.$el, w.files), true, 'the valid token still checks: a.png is not .pdf');
            assert.equal(w.log.warn.length, 1, 'one warning');
            ['jpg', 'image/png;q=1', 'image/', '/png', 'image'].forEach(function (t) {
                assert.ok(w.log.warn[0].indexOf(t) > -1, 'the warning names ' + t);
            });
            assert.equal(w.log.warn[0].indexOf('.pdf'), -1, 'and not the valid token');
            assert.equal(refuses(attrs, file('a.pdf')), false, 'the valid token matches');
            var none = world({ attrs: ' accept="jpg, png"', files: [file('a.exe', '')] });
            assert.equal(none.refuse(none.$el, none.files), false, 'no valid token: no type is checked');
            assert.equal(none.log.warn.length, 1, 'still warned');
            var prod = world({ dev: false, attrs: ' accept="jpg"', files: [file('a.exe', '')] });
            assert.equal(prod.refuse(prod.$el, prod.files), false);
            assert.equal(prod.log.warn.length, 0, 'outside dev, no warning');
        });

        it('02.19 - the missing action is checked first: its refusal names every file and runs no client check', function () {
            var w = world({ action: false, attrs: ' multiple accept=".pdf"' + ON_ERR, files: [file('a.png', 'image/png'), file('b.pdf', 'application/pdf')] });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.deepEqual(slotLines(w), ['a.png, b.pdf was not uploaded']);
            assert.deepEqual(w.log.calls[0].data, { refused: true, reason: 'action', files: ['a.png', 'b.pdf'], error: 'a.png, b.pdf was not uploaded', transportError: false });
            var bad = world({ action: false, attrs: ' accept="jpg"', files: [file('a.pdf')] });
            assert.equal(bad.refuse(bad.$el, bad.files), true);
            assert.equal(bad.log.warn.length, 0, 'the accept tokens are not even read');
        });

        it('02.20 - gina.config.a11y translates both lines, in the slot, the announcement and the result', function () {
            var w = world({ a11y: { uploadTypeRefused: '%s : type de fichier refusé', uploadSizeRefused: '%s : fichier trop lourd' }, attrs: ' multiple accept=".pdf" data-gina-form-upload-max-size="1KB"' + ON_ERR, files: [file('a.png', 'image/png'), file('b.pdf', 'application/pdf', 2048)] });
            callback(w, 'onDocError');
            w.refuse(w.$el, w.files);
            assert.deepEqual(slotLines(w), ['a.png : type de fichier refusé', 'b.pdf : fichier trop lourd']);
            assert.equal(w.log.announce[0].text, 'a.png : type de fichier refusé. b.pdf : fichier trop lourd');
            assert.equal(w.log.calls[0].data.error, 'a.png : type de fichier refusé. b.pdf : fichier trop lourd');
        });

        it('02.21 - names holding markup or replacement patterns are written as text, as they are', function () {
            var w = world({ attrs: ' multiple accept=".pdf" data-gina-form-upload-max-size="1b"', files: [file('<img src=x onerror=1>.png', 'image/png'), file('c$&d.gif', 'image/gif'), file('a$&b$1.pdf', 'application/pdf', 2)] });
            assert.equal(w.refuse(w.$el, w.files), true);
            var slot = w.doc.getElementById('doc-error');
            assert.equal(slot.getElementsByTagName('img').length, 0, 'no element is built from a name');
            assert.deepEqual(slotLines(w), ['<img src=x onerror=1>.png, c$&d.gif was not uploaded: this type of file is not accepted', 'a$&b$1.pdf was not uploaded: the file is too large']);
        });

        it('02.22 - no slot: announced, a dev warning names the slot, the callback still runs', function () {
            var w = world({ slot: false, attrs: ' accept=".pdf"' + ON_ERR });
            callback(w, 'onDocError');
            assert.equal(w.refuse(w.$el, w.files), true);
            assert.equal(w.log.announce.length, 1);
            assert.equal(w.log.announce[0].text, 'a.png was not uploaded: this type of file is not accepted');
            assert.equal(w.log.warn.length, 1);
            assert.match(w.log.warn[0], /#doc-error/);
            assert.equal(w.log.calls.length, 1);
        });

        it('02.23 - a newer selection made before the timer runs is left on the input', async function () {
            var w = world({ attrs: ' accept=".pdf"' });
            assert.equal(w.refuse(w.$el, w.files), true);
            w.held.list = [file('c.pdf', 'application/pdf')];
            await tick();
            assert.equal(w.held.values.length, 0, 'not emptied');
            assert.equal(w.$el.files[0].name, 'c.pdf');
        });
    });

    describe('03 - dist fidelity', function () {
        it('03.1 - the unminified bundle carries the same helper and the two labels', function () {
            var raw = stripComments(fs.readFileSync(DIST_RAW, 'utf8'));
            assert.equal(cutExpression(raw, REFUSE_DECL, 'gina.js'), cutExpression(CODE, REFUSE_DECL, 'src'), 'the helper, as in the source');
            var labels = cutExpression(raw, LABELS_DECL, 'gina.js');
            assert.ok(labels.indexOf("uploadTypeRefused   : '" + TYPE_TEXT + "'") > -1, 'the type label');
            assert.ok(labels.indexOf("uploadSizeRefused   : '" + SIZE_TEXT + "'") > -1, 'the size label');
        });

        it('03.2 - the minified bundle carries the labels, the grammar and the max-size attribute once, and the listener\'s one call', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal((min.match(/uploadTypeRefused\s*:\s*(['"])%s was not uploaded: this type of file is not accepted\1/g) || []).length, 1, 'the type label');
            assert.equal((min.match(/uploadSizeRefused\s*:\s*(['"])%s was not uploaded: the file is too large\1/g) || []).length, 1, 'the size label');
            assert.equal(count(min, GRAMMAR), 1, 'the size grammar');
            assert.equal((min.match(/getAttribute\((['"])data-gina-form-upload-max-size\1\)/g) || []).length, 1, 'the size attribute, read once');
            assert.equal((min.match(/getAttribute\((['"])accept\1\)/g) || []).length, 1, 'the accept attribute, read once');
            var MIN_CALL = /\.length\)\s*return\s*!1\s*;\s*if\s*\(\s*!?\s*([\w$]+)\s*\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*\)\s*(?:return\s*;|\{)\s*\2\s*\.\s*pendingFiles\s*=\s*Array\.from\(\s*\3\s*\)/g;
            assert.equal((min.match(MIN_CALL) || []).length, 1, 'the listener calls the helper once, between its return and its pending write');
        });

        it('[instrument] the minified bundle holds the #B1094 label the patterns above sit beside', function () {
            var min = fs.readFileSync(DIST_MIN, 'utf8');
            assert.equal((min.match(/uploadNotSent\s*:\s*(['"])%s was not uploaded\1/g) || []).length, 1);
        });
    });
});
