'use strict';
/**
 * The framework's own log lines cannot be forged by a request (#B830, the sites).
 *
 * A line break inside a value that a request supplied used to start a physical
 * log line of its own wherever the framework concatenated that value into a
 * message (CWE-117). Each such site now writes the value with its control
 * characters as visible escapes, or — for an error detail — keeps a real line
 * feed only before a stack-frame line. This file holds one arm per site.
 *
 *   01  isaac — a query string with no `&` and no `=` that is not JSON
 *   02  isaac — the engine.io message handler (three lines)
 *   03  helpers/context — throwError: the pairing line and the fatal line
 *   04  controller — the two late-error lines, « Ignoring message », the redirect notice
 *   05  lib/lane — the late-call line and its « Ignoring message » twin
 *   06  lib/routing — the placeholder warning
 *   07  render-swig — the naming-convention lines, « Path exception », « could not open »
 *   08  the validator — the two condition warnings
 *   09  core/server.js — the upload messages, the body-parse warnings, the content-type
 *       lines, and the central error line
 *   10  controller — the three central error lines
 *   11  lib/lane — the central error line
 *   12  the validator — the `isDate` warning
 *
 * No replica: every arm slices the site's own statements out of the source and
 * runs those bytes with the file's own escapers (also sliced from that file),
 * so the same file runs against another tree (`GINA_B830_FW`) — on the bytes
 * that precede the fix every site arm prints a forged line and fails.
 * The logger and the redaction have their own files.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW = process.env.GINA_B830_FW || path.resolve(require('../fw'));

function ch(code) { return String.fromCharCode(code); }
var BS = ch(92), LF = ch(10), TAB = ch(9);
/** A value a client could send: a line break, then text shaped like a log record. */
var FORGED = '[2026 Oct 09 21:00:00] [info   ][app@proj] forged';
var EVIL   = 'x' + LF + FORGED;

function read(rel) { return fs.readFileSync(path.join(FW, rel), 'utf8'); }
/** The source without its full-line `//` comments: a kept `// was:` line must not answer for the code. */
function active(src) { return src.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); }

/** `src` from `from` (unique) up to the first `to` after it; `to` itself is left out. */
function between(src, from, to, label) {
    var a = src.indexOf(from);
    if (a < 0) { throw new Error('[instrument] ' + label + ': start anchor not found'); }
    if (src.indexOf(from, a + 1) > -1) { throw new Error('[instrument] ' + label + ': start anchor not unique'); }
    var b = src.indexOf(to, a + from.length);
    if (b < 0) { throw new Error('[instrument] ' + label + ': end anchor not found'); }
    return src.slice(a, b);
}
/** The function whose text starts at `at`, up to its matching closing brace. */
function fnFrom(src, at, label) {
    var depth = 0, started = false, j = at;
    for (; j < src.length; j++) {
        var c = src.charAt(j);
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    if (!started || depth !== 0) { throw new Error('[instrument] ' + label + ': braces do not balance'); }
    return src.slice(at, j);
}
/** The file's own escaper pair, built from its bytes; a function it does not declare is `undefined`. */
function escapersOf(src) {
    var out = { esc: undefined, keep: undefined };
    var e = src.indexOf('function escapeLogControlChars(value) {'), k = src.indexOf('function escapeLogDetailKeepFrames(detail) {');
    if (e > -1) {
        var eText = fnFrom(src, e, 'escaper');
        out.esc = new Function(eText + '\nreturn escapeLogControlChars;')();
        if (k > -1) { out.keep = new Function(eText + '\n' + fnFrom(src, k, 'frame-keeping escaper') + '\nreturn escapeLogDetailKeepFrames;')(); }
    }
    return out;
}
/** A console whose calls are recorded per level, arguments joined the way the logger joins them. */
function recorder() {
    var rec = { warn: [], error: [], debug: [], emerg: [], all: [] };
    ['warn', 'error', 'debug', 'emerg'].forEach(function (level) {
        rec[level + 'Fn'] = function () {
            var line = Array.prototype.slice.call(arguments).map(function (a) { return (a instanceof Error) ? a.stack : String(a); }).join(' ');
            rec[level].push(line); rec.all.push(line);
        };
    });
    rec.console = { warn: rec.warnFn, error: rec.errorFn, debug: rec.debugFn, emerg: rec.emergFn, err: rec.errorFn, warning: rec.warnFn };
    return rec;
}
/** Every line of `src` holding `needle`, trimmed: a one-line statement, sliced whole. */
function linesWith(src, needle) {
    return src.split('\n').filter(function (l) { return l.indexOf(needle) > -1; }).map(function (l) { return l.trim(); });
}
/** The one line of `src` holding `needle` (instrument: exactly one). */
function lineWith(src, needle, label) {
    var lines = linesWith(src, needle);
    if (lines.length !== 1) { throw new Error('[instrument] ' + label + ': ' + lines.length + ' lines hold the anchor, 1 expected'); }
    return lines[0];
}
/** Does a physical line of `text` begin with the forged record? */
function forgesALine(text) { return text.split(LF).some(function (l) { return l.indexOf(FORGED) === 0; }); }
/** One site's verdict: the forged text is on the line of the value before it, behind a visible escape. */
function assertNotForged(line, label) {
    assert.equal(forgesALine(line), false, label + ' — a forged line starts in: ' + JSON.stringify(line).slice(0, 260));
    assert.ok(line.indexOf(BS + 'n' + FORGED) > -1, label + ' — the break is shown as a visible escape: ' + JSON.stringify(line).slice(0, 260));
}

describe('00 - INSTRUMENT: the helpers of this file', function () {

    it('forgesALine() fires on a forged line and not on an escaped one', function () {
        assert.equal(forgesALine('a ' + EVIL), true);
        assert.equal(forgesALine('a x' + BS + 'n' + FORGED), false);
    });

    it('between() and fnFrom() refuse a missing, repeated or unbalanced anchor', function () {
        assert.throws(function () { between('abc', 'x', 'c', 't'); }, /start anchor not found/);
        assert.throws(function () { between('axbxc', 'x', 'c', 't'); }, /start anchor not unique/);
        assert.throws(function () { between('axb', 'x', 'c', 't'); }, /end anchor not found/);
        assert.throws(function () { fnFrom('function () { if (a) {', 0, 't'); }, /braces do not balance/);
        assert.equal(fnFrom('function () { if (a) { b(); } } tail', 0, 't'), 'function () { if (a) { b(); } }');
    });

    it('active() drops a full-line comment and keeps a trailing one', function () {
        assert.equal(active('a(); // keep\n    // was: b();\nc();'), 'a(); // keep\nc();');
    });
});


// ─── 01  isaac: the bare query string ───────────────────────────────────────
describe('01 - core/server.isaac.js: a query string that is neither a pair nor JSON', function () {
    var SRC  = active(read('core/server.isaac.js'));
    var BODY = between(SRC, '} else { // for redirection purposes or when passing `?encodedJsonObject`', "\n                        }\n\n                    }\n                    request.url = request.url.split('?')[0]", 'bare-query block')
        .slice('} else { // for redirection purposes or when passing `?encodedJsonObject`'.length);
    function drive(raw) {
        var rec = recorder(), request = { query: {} }, a = [raw];
        new Function('a', 'request', 'console', BODY)(a, request, rec.console);
        return { rec: rec, request: request };
    }

    it('a decoded line break and a forged record: one line, with the length and the error name, none of the text', function () {
        var r = drive('x%0A' + encodeURIComponent(FORGED));
        assert.equal(r.rec.all.length, 1, 'one line is logged');
        assert.equal(r.rec.all[0].indexOf(LF), -1, 'no line break: ' + JSON.stringify(r.rec.all[0]));
        assert.equal(r.rec.all[0].indexOf('forged'), -1, 'none of the client text is printed');
        assert.match(r.rec.all[0], /\(\d+ chars, SyntaxError\)/);
        assert.deepEqual(r.request.query, {}, 'the query stays empty');
    });

    it('a malformed percent sequence names its own error', function () {
        var r = drive('%E0%A4%A');
        assert.equal(r.rec.all.length, 1);
        assert.match(r.rec.all[0], /\(\d+ chars, URIError\)/);
    });

    it('CONTROL: an encoded JSON object is still read, and logs nothing', function () {
        var r = drive(encodeURIComponent('{"a":1}'));
        assert.deepEqual(r.request.query, { a: 1 });
        assert.equal(r.rec.all.length, 0);
    });
});


// ─── 02  isaac: the engine.io message handler ───────────────────────────────
describe('02 - core/server.isaac.js: the socket message handler', function () {
    var SRC  = active(read('core/server.isaac.js'));
    var OPEN = "socket.on('message', ";
    var at   = SRC.indexOf(OPEN);
    var E    = escapersOf(SRC);
    function handler(rec) {
        if (at < 0 || SRC.indexOf(OPEN, at + 1) > -1) { throw new Error('[instrument] the message handler must be found exactly once'); }
        return new Function('console', 'options', 'server', 'socket', 'escapeLogControlChars', 'escapeLogDetailKeepFrames',
            'return (' + fnFrom(SRC, at + OPEN.length, 'message handler') + ');')(rec.console, { isCacheless: false }, {}, { send: function () {} }, E.esc, E.keep);
    }

    it('a message holding a line break: the debug line stays on one line', function () {
        var rec = recorder();
        handler(rec).call({ id: 's1', sessionId: 'own' }, EVIL);
        assert.equal(rec.debug.length, 1);
        assertNotForged(rec.debug[0], 'debug line');
    });

    it('the same message is not JSON: the error line keeps its frames and forges nothing', function () {
        var rec = recorder();
        handler(rec).call({ id: 's1', sessionId: 'own' }, EVIL);
        assert.equal(rec.error.length, 1);
        assert.equal(forgesALine(rec.error[0]), false, JSON.stringify(rec.error[0]).slice(0, 260));
        rec.error[0].split(LF).slice(1).forEach(function (l) { assert.match(l, /^\s+at\s/, 'only a frame line starts a new line: ' + l.slice(0, 80)); });
    });

    it('a session id asserted by the client, holding a line break: the warning stays on one line', function () {
        var rec = recorder();
        handler(rec).call({ id: 's1', sessionId: 'own' }, JSON.stringify({ session: { id: EVIL } }));
        assert.equal(rec.warn.length, 1);
        assertNotForged(rec.warn[0], 'asserted-session warning');
        assert.equal(rec.error.length, 0);
    });

    it('CONTROL: a well-formed message from the bound session warns about nothing', function () {
        var rec = recorder();
        handler(rec).call({ id: 's1', sessionId: 'own' }, JSON.stringify({ session: { id: 'own' }, type: 'ping' }));
        assert.equal(rec.warn.length + rec.error.length, 0);
        assert.equal(rec.debug.length, 1);
    });
});


// ─── 03  helpers/context: throwError ────────────────────────────────────────
describe('03 - helpers/context.js: throwError', function () {
    var RAW = read('helpers/context.js');
    var start = RAW.indexOf('function(code, err, isFatal) {');
    var end   = RAW.indexOf('throw err', start);
    var FN    = RAW.slice(start, end + 'throw err'.length) + '\n}';
    var MINT  = RAW.match(/var _mintErrorRef = function\(supplied\) \{[\s\S]*?\n\};/);
    function build(rec, router) {
        assert.ok(start > -1 && end > start && MINT, '[instrument] throwError and its ref helper must be found');
        var mint = new Function('crypto', MINT[0] + '\nreturn _mintErrorRef;')(require('crypto'));
        var getContext = function (key) { return key === 'router' ? router : (key === 'bundle' ? 'app' : undefined); };
        return new Function('getContext', 'console', '_mintErrorRef', 'process', 'return (' + FN + ');')(getContext, rec.console, mint, { env: { NODE_SCOPE_IS_LOCAL: 'false' } });
    }
    function liveRes() { return { headersSent: false, req: { method: 'GET', url: '/x', _ginaReqId: 'r-1' }, writeHead: function () {}, end: function () {} }; }

    it('the pairing line: a message holding a line break stays behind the header, the frames keep their lines', function () {
        var rec = recorder(), err = new Error('bad value ' + EVIL);
        build(rec, { response: liveRes(), next: null })(500, err);
        assert.equal(rec.error.length, 1);
        assert.ok(rec.error[0].indexOf('[ CONTEXT ][ app ][ ref ') === 0);
        assertNotForged(rec.error[0], 'pairing line');
        var lines = rec.error[0].split(LF);
        assert.ok(lines.length > 2, 'CONTROL: the stack frames are still on their own lines');
        lines.slice(2).forEach(function (l) { assert.match(l, /^\s+at\s/, l.slice(0, 80)); });
    });

    it('the fatal line (no response to answer): the same detail, the same escape', function () {
        var rec = recorder(), err = new Error('bad value ' + EVIL);
        build(rec, null)(500, err, true);
        assert.equal(rec.emerg.length, 1);
        assertNotForged(rec.emerg[0], 'fatal line');
        rec.emerg[0].split(LF).slice(1).forEach(function (l) { assert.match(l, /^\s+at\s/, l.slice(0, 80)); });
    });

    it('CONTROL: an ordinary error is logged with its message and its frames, unchanged', function () {
        var rec = recorder(), err = new Error('plain failure');
        build(rec, { response: liveRes(), next: null })(500, err);
        assert.ok(rec.error[0].indexOf(LF + err.stack) > -1, 'the detail is the stack as it is');
    });
});


// ─── 04  controller ─────────────────────────────────────────────────────────
describe('04 - core/controller/controller.js', function () {
    var SRC = active(read('core/controller/controller.js'));
    var E   = escapersOf(SRC);
    var P   = ['console', 'escapeLogControlChars', 'escapeLogDetailKeepFrames'];
    function run(body, names, values, rec) {
        return new Function(names.concat(P).join(','), body).apply(null, values.concat([rec.console, E.esc, E.keep]));
    }

    it('throwError() after the response was released (the early guard): the late error stays on its line', function () {
        var body = between(SRC, '        if ( !res ) {\n            self.isProcessingError = true;', '\n            return false;\n        }', 'early late-error guard') + '\n return false; }';
        var rec = recorder();
        assert.equal(run(body, ['res', 'msg', 'code', 'self'], [undefined, 'bad value ' + EVIL, 500, {}], rec), false);
        assert.equal(rec.warn.length, 1);
        assertNotForged(rec.warn[0], 'early guard');
    });

    it('throwError() after the response was released (the second guard): the same', function () {
        var body = between(SRC, '        if ( !res ) {\n            var _lateError = errorObject || msg || code;', '\n            return false;\n        }', 'second late-error guard') + '\n return false; }';
        var rec = recorder();
        assert.equal(run(body, ['res', 'errorObject', 'msg', 'code'], [undefined, undefined, 'bad value ' + EVIL, 500], rec), false);
        assertNotForged(rec.warn[0], 'second guard');
    });

    it('a late error passed as a stack keeps its frame lines', function () {
        var body = between(SRC, '        if ( !res ) {\n            var _lateError = errorObject || msg || code;', '\n            return false;\n        }', 'second late-error guard') + '\n return false; }';
        var rec = recorder(), stack = 'Error: late' + LF + '    at f (a.js:1:1)' + LF + '    at g (b.js:2:2)';
        run(body, ['res', 'errorObject', 'msg', 'code'], [undefined, undefined, stack, 500], rec);
        assert.ok(rec.warn[0].indexOf(stack) > -1, 'CONTROL: a real stack is printed as it is');
    });

    it('« Ignoring message because of the format »: a message that is not a string stays on its line', function () {
        var body = between(SRC, "                if (res.message && typeof(res.message) == 'string') {", "\n\n\n\n            } else if ( typeof(arguments[arguments.length-1]) == 'string' ) {", 'ignoring-message statement');
        var rec = recorder();
        run(body, ['res', 'errorObject'], [{ message: [EVIL] }, {}], rec);
        assert.equal(rec.warn.length, 1);
        var value = rec.warn[0].slice(rec.warn[0].indexOf('format.') + 'format.'.length + 1);   // after the line break the message has by design
        assert.equal(value.indexOf(LF), -1, JSON.stringify(rec.warn[0]));
        assert.ok(value.indexOf(BS + 'n' + FORGED) > -1);
    });

    it('redirect(): the names of the fields left behind are a client text too', function () {
        var body = between(SRC, '                if ( _droppedCarry.length > 0 ) {', '\n                requestParams = _carriedParams;', 'redirect notice');
        var rec = recorder();
        run(body, ['_droppedCarry'], [['password' + LF + FORGED, 'token']], rec);
        assert.equal(rec.debug.length, 1);
        assertNotForged(rec.debug[0], 'redirect notice');
    });
});


// ─── 05  lib/lane ───────────────────────────────────────────────────────────
describe('05 - lib/lane/src/main.js', function () {
    var SRC = active(read('lib/lane/src/main.js'));
    var E   = escapersOf(SRC);

    function lateCall(rec) {
        var at = SRC.indexOf('function logLateCall(what, payload) {');
        assert.ok(at > -1 && SRC.indexOf('function logLateCall(what, payload) {', at + 1) === -1, '[instrument] logLateCall must be declared once');
        return new Function('logger', 'escapeLogControlChars', 'escapeLogDetailKeepFrames', fnFrom(SRC, at, 'logLateCall') + '\nreturn logLateCall;')(rec.console, E.esc, E.keep);
    }

    it('a write after the response was released: a string payload stays on its line', function () {
        var rec = recorder();
        lateCall(rec)('error()', 'bad value ' + EVIL);
        assert.equal(rec.warn.length, 1);
        assertNotForged(rec.warn[0], 'late call');
    });

    it('an Error payload: its message stays on its line, its frames keep theirs', function () {
        var rec = recorder(), err = new Error('bad value ' + EVIL);
        lateCall(rec)('error()', err);
        assertNotForged(rec.warn[0], 'late call, Error');
        rec.warn[0].split(LF).slice(1).forEach(function (l) { assert.match(l, /^\s+at\s/, l.slice(0, 80)); });
    });

    it('CONTROL: an object payload is printed as JSON, as before', function () {
        var rec = recorder();
        lateCall(rec)('json()', { second: 2 });
        assert.equal(rec.warn[0], '[ Lane ] json() called after the response was released — ignoring: {"second":2}');
    });

    it('« Ignoring message because of the format »: a message that is not a string stays on its line', function () {
        var body = between(SRC, "            if ( res.message && typeof(res.message) == 'string' ) {", "\n        } else if ( typeof(last) == 'string' ) {", 'ignoring-message statement');
        var rec = recorder();
        new Function('res', 'errorObject', 'logger', 'escapeLogControlChars', 'escapeLogDetailKeepFrames', body)({ message: [EVIL] }, {}, rec.console, E.esc, E.keep);
        assert.equal(rec.warn.length, 1);
        var value = rec.warn[0].slice(rec.warn[0].indexOf('format.') + 'format.'.length + 1);
        assert.equal(value.indexOf(LF), -1, JSON.stringify(rec.warn[0]));
        assert.ok(value.indexOf(BS + 'n' + FORGED) > -1);
    });
});


// ─── 06  lib/routing ────────────────────────────────────────────────────────
describe('06 - lib/routing/src/main.js: the placeholder warning', function () {
    var SRC  = active(read('lib/routing/src/main.js'));
    var E    = escapersOf(SRC);
    var BODY = between(SRC, '        if (\n            /\\:/.test(route.url)', '\n\n        return route\n    };', 'placeholder block');
    function drive(url) {
        var rec = recorder(), warned = [];
        rec.console.warn = function (e) { warned.push(e); };
        new Function('route', 'rule', 'msg', 'console', 'escapeLogControlChars', BODY)({ url: url }, 'home@app', null, rec.console, E.esc);
        return warned;
    }

    it('a route URL holding a request value with a line break: the warning has its own line break and no other', function () {
        var warned = drive('/app/:id/' + EVIL);
        assert.equal(warned.length, 1);
        assert.ok(warned[0] instanceof Error);
        assert.equal(warned[0].message.split(LF).length, 2, 'the one break the message has by design: ' + JSON.stringify(warned[0].message));
        assertNotForged(warned[0].message, 'placeholder warning');
    });

    it('CONTROL: an ordinary unresolved placeholder is reported as before', function () {
        var warned = drive('/app/:id/edit');
        assert.ok(warned[0].message.indexOf('param placeholder not defined: `/app/:id/edit` !' + LF + ' Check your route description') > -1);
        assert.ok(warned[0].message.indexOf('route [ home@app ]') > -1);
    });
});


// ─── 07  render-swig ────────────────────────────────────────────────────────
describe('07 - core/controller/controller.render-swig.js', function () {
    var SRC = active(read('core/controller/controller.render-swig.js'));
    var E   = escapersOf(SRC);

    it('the naming-convention lines: a template file name holding a line break stays on its line', function () {
        var body = between(SRC, "            if ( file.charAt(0) !== '.' && file.charAt(0) !== '/' && file.charAt(0) !== '\\\\' && file != fileNamingConvention ) {", '\n            fileNamingConvention = null;', 'naming-convention block');
        var rec = recorder(), file = 'ns-' + EVIL;
        new Function('file', 'fileNamingConvention', 'localOptions', 'data', 'console', 'escapeLogControlChars', body)(
            file, EVIL, { namespace: 'ns', rule: 'home@app' }, { page: { view: { ext: '.html' } } }, rec.console, E.esc);
        assert.equal(rec.warn.length, 2);
        assert.equal(rec.warn[0].indexOf(LF), -1, JSON.stringify(rec.warn[0]).slice(0, 260));
        assert.equal(forgesALine(rec.warn[0]), false);
        assert.equal(forgesALine(rec.warn[1]), false, JSON.stringify(rec.warn[1]).slice(0, 260));
        assert.equal(rec.warn[1].split(LF).length, 2, 'the one break the second line has by design');
    });

    it('« Path exception »: a file-system error quoting a path with a line break', function () {
        var body = between(SRC, '    } catch (pathException) {', '\n    }\n    var hasLayoutInPath', 'path-exception catch').slice('    } catch (pathException) {'.length);
        var rec = recorder(), fsErr = null;
        try { fs.readFileSync(path.join('/nonexistent-b830', EVIL)); } catch (e) { fsErr = e; }
        assert.ok(fsErr && fsErr.message.indexOf(LF + FORGED) > -1, 'PREMISE: the file-system error quotes the path, line break included');
        new Function('pathException', 'console', 'escapeLogControlChars', 'escapeLogDetailKeepFrames', body)(fsErr, rec.console, E.esc, E.keep);
        assert.equal(rec.warn.length, 1);
        assertNotForged(rec.warn[0], 'path exception');
    });

    it('« could not open »: the message names the path on one line and keeps the breaks it has by design', function () {
        var body = between(SRC, "            msg = 'could not open \"'+", '\n            err = new ApiError(msg, 500);', 'could-not-open statement');
        var p = '/srv/app/templates/html/' + EVIL + '.html';
        var msg = new Function('path', 'localOptions', 'escapeLogControlChars', 'var msg;\n' + body + '\nreturn msg;')(
            p, { rule: 'home@app', conf: { bundlePath: '/srv/app', content: { routing: { 'home@app': { url: '/' } } } } }, E.esc);
        assert.equal(forgesALine(msg), false, JSON.stringify(msg).slice(0, 300));
        assert.equal(msg.split(BS + 'n' + FORGED).length - 1, 2, 'the path is named twice, each time with its break shown');
        assert.ok(msg.indexOf(LF + '1) The requested file') > -1 && msg.indexOf(LF + '3) At this point') > -1, 'CONTROL: the designed line breaks are kept');
    });
});


// ─── 08  the validator ──────────────────────────────────────────────────────
describe('08 - the validator: a condition that cannot be evaluated', function () {
    process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
    process.setMaxListeners(0);
    // the globals come from the SAME tree as the engine, or the engine reads another context store
    require(path.join(FW, '../../utils/prototypes'));
    require(path.join(FW, 'helpers'));
    /* global getContext, setContext */
    if (typeof getContext('gina') === 'undefined') { setContext('gina', { forms: null }); }
    setContext('bundle', 'b830sites');
    var FormValidator = require(path.join(FW, 'core/plugins/lib/validator/src/form-validator.js'));
    // a first call loads what the engine requires lazily, so the capture below hooks the console it really uses
    new FormValidator({ a: 'x' })['a'].is('"x" === "x"', 'mismatch');

    function withWarns(fn) {
        var warns = [], orig = console.warn;
        console.warn = function (m) { warns.push(String(m)); };
        try { var r = fn(); return { result: r, warns: warns }; } finally { console.warn = orig; }
    }

    it('a value that is not a string is spliced as it is: its line break stays on the line of the condition', function () {
        var r = withWarns(function () { return new FormValidator({ a: [EVIL], b: 'y' })['b'].is('$a === $b', 'mismatch'); });
        assert.equal(r.result.valid, false);
        assert.equal(r.warns.length, 1);
        assert.match(r.warns[0], /Could not evaluate condition/);
        assertNotForged(r.warns[0], 'condition warning');
        assert.equal(r.warns[0].split(LF).length, 2, 'the one break the warning has by design');
    });

    it('CONTROL: a refused condition with ordinary values is reported as before', function () {
        var r = withWarns(function () { return new FormValidator({ a: 'x' })['a'].is('$isValid === "x"', 'mismatch'); });
        assert.equal(r.warns.length, 1);
        assert.ok(r.warns[0].indexOf('Could not evaluate condition `$isValid === "x"` - treating field as invalid.' + LF + '(grammar:') > -1, r.warns[0]);
    });
});


// ─── 09  core/server.js ─────────────────────────────────────────────────────
describe('09 - core/server.js', function () {
    var SRC = active(read('core/server.js'));
    var E   = escapersOf(SRC);
    /** An error whose message quotes what the client sent, the way a JSON.parse error quotes a short body. */
    function quoting() { return new SyntaxError('Unexpected token in the body: ' + EVIL); }

    it('the upload messages: a field name, a group and an extension taken from the part headers', function () {
        var cases = [
            ["throwError(response, 400, 'multipart text field `'", 'text field'],
            ['` is not a configured upload group.', 'group'],
            ['` is not an allowed extension.', 'extension'],
            ["'upload destination for group `'", 'destination']
        ];
        cases.forEach(function (c) {
            var sent = [];
            new Function('throwError', 'response', 'next', 'name', 'fileGroup', 'fileExt', 'fileUploadDir', 'mkdirErr', 'escapeLogControlChars', lineWith(SRC, c[0], c[1]))(
                function (res, code, msg) { sent.push(msg); }, {}, null, EVIL, EVIL, EVIL, '/srv/uploads/g', new Error('EACCES: permission denied'), E.esc);
            assert.equal(sent.length, 1, c[1]);
            assertNotForged(sent[0], 'upload ' + c[1]);
        });
    });

    it('the nine body-parse lines: the message of the parser error, on the line after the URL and on that line only', function () {
        var needles = ["'[ Could properly evaluate POST ] '", "'[ Exception found for POST ] '", "'[ Could complete POST ] '", "'[ Could not parse application/json PUT body ] '",
            "'[ Could not properly evaluate PATCH ] '", "'[ Exception found for PATCH ] '", "'[ Could not complete PATCH ] '"];
        var lines = [];
        needles.forEach(function (n) { lines = lines.concat(linesWith(SRC, n)); });
        assert.equal(lines.length, 9, '[instrument] nine statements build a body-parse line');
        lines.forEach(function (line) {
            var rec = recorder();
            var msg = new Function('request', 'err', 'console', 'escapeLogControlChars', 'var msg;\n' + line + '\nreturn msg;')({ url: '/api/x' }, quoting(), rec.console, E.esc);
            var text = (typeof msg === 'string') ? msg : rec.warn[0];
            assert.equal(text.split(LF).length, 2, 'the one break the line has by design: ' + line.slice(0, 60));
            assertNotForged(text, line.slice(0, 50));
        });
    });

    it('the content-type lines: a file name taken from the request path', function () {
        var rec = recorder();
        new Function('filename', 's', 'console', 'escapeLogControlChars', lineWith(SRC, '` not supported by gina: `core/mime.types`', 'unsupported extension'))('/static/' + EVIL, ['', '', EVIL], rec.console, E.esc);
        assert.equal(rec.warn.length, 1);
        assert.equal(rec.warn[0].indexOf(LF), -1, JSON.stringify(rec.warn[0]).slice(0, 200));
        var rec2 = recorder();
        new Function('filename', 'err', 'console', 'escapeLogControlChars', lineWith(SRC, "'Error while trying to getContentTypeByFilename('", 'content-type error'))('/static/' + EVIL, new Error('boom'), rec2.console, E.esc);
        assertNotForged(rec2.error[0], 'content-type error');
    });

    it('the central error line: a detail holding a client value, and a detail that is a stack', function () {
        var line = lineWith(SRC, "console.error('[ BUNDLE ][ '+ self.appName +' ][ ref '+ ref +' ][ req '", 'central line');
        var drive = function (detail) {
            var rec = recorder();
            new Function('self', 'ref', '_req', '_displayCode', '_errDetail', 'console', 'escapeLogControlChars', 'escapeLogDetailKeepFrames', line)(
                { appName: 'app' }, 'ABC123', { _ginaReqId: 'r-1', method: 'POST', url: '/upload' }, 400, detail, rec.console, E.esc, E.keep);
            return rec.error[0];
        };
        assertNotForged(drive('`' + EVIL + '` is not a configured upload group.'), 'central line');
        var stack = 'Error: boom' + LF + '    at f (a.js:1:1)' + LF + '    at g (b.js:2:2)';
        assert.ok(drive(stack).indexOf(LF + stack) > -1, 'CONTROL: a stack keeps its frame lines');
    });
});


// ─── 10  controller: the central error lines ────────────────────────────────
describe('10 - core/controller/controller.js: the three central error lines', function () {
    var SRC = active(read('core/controller/controller.js'));
    var E   = escapersOf(SRC);
    var NAMES = ['bundleConf', 'errorObject', 'req', 'res', 'code', '_errRef', '_errDetail', '_logMsg', '_msgLog', 'console', 'escapeLogControlChars', 'escapeLogDetailKeepFrames'];
    function drive(needle, label, detail) {
        var rec = recorder();
        new Function(NAMES.join(','), lineWith(SRC, needle, label))(
            { bundle: 'app' }, { ref: 'ABC123', status: 500 }, { _ginaReqId: 'r-1', method: 'GET', url: '/x' }, { statusCode: 500 }, 500, 'ABC123', detail, detail, detail, rec.console, E.esc, E.keep);
        return rec.error[0];
    }
    var SITES = [
        ["' ][ Controller ][ ref '+ errorObject.ref +'", 'JSON branch'],
        ["+' [ '+ errorObject.status +' ] '+ req.url + '\\n'+", 'page branch'],
        ["+' [ '+ code +' ] '+ req.url + ( _msgLog ?", 'object branch']
    ];

    it('a detail holding a client value stays behind the header line', function () {
        SITES.forEach(function (s) { assertNotForged(drive(s[0], s[1], 'bad value ' + EVIL), 'controller ' + s[1]); });
    });

    it('CONTROL: a detail that is a stack keeps its frame lines', function () {
        var stack = 'Error: boom' + LF + '    at f (a.js:1:1)' + LF + '    at g (b.js:2:2)';
        SITES.forEach(function (s) { assert.ok(drive(s[0], s[1], stack).indexOf(LF + stack) > -1, s[1]); });
    });
});


// ─── 11  lib/lane: the central error line ───────────────────────────────────
describe('11 - lib/lane/src/main.js: the central error line', function () {
    var SRC = active(read('lib/lane/src/main.js'));
    var E   = escapersOf(SRC);
    function drive(detail) {
        var rec = recorder();
        new Function('logger', 'bundle', 'errorObject', 'req', 'code', 'detail', 'escapeLogControlChars', 'escapeLogDetailKeepFrames', lineWith(SRC, "' ][ Lane ][ ref '+ errorObject.ref +'", 'lane central line'))(
            rec.console, 'app', { ref: 'ABC123', status: 500 }, { _ginaReqId: 'r-1', method: 'GET', url: '/x' }, 500, detail, E.esc, E.keep);
        return rec.error[0];
    }

    it('a detail holding a client value stays behind the header line', function () {
        assertNotForged(drive('bad value ' + EVIL), 'lane central line');
    });

    it('CONTROL: a detail that is a stack keeps its frame lines', function () {
        var stack = 'Error: boom' + LF + '    at f (a.js:1:1)';
        assert.ok(drive(stack).indexOf(LF + stack) > -1);
    });
});


// ─── 12  the validator: isDate ──────────────────────────────────────────────
describe('12 - the validator: the `isDate` warning', function () {
    var SRC = active(read('core/plugins/lib/validator/src/form-validator.js'));
    var E   = escapersOf(SRC);

    it('a field name and a value taken from the request body stay on one line', function () {
        var rec = recorder();
        new Function('val', 'console', 'escapeLogControlChars', lineWith(SRC, "'[FormValidator::isDate] Provided value for field `'", 'isDate warning')).call({ name: 'birth' + LF + FORGED }, 'NaN' + LF + FORGED, rec.console, E.esc);
        assert.equal(rec.warn.length, 1);
        assert.equal(rec.warn[0].indexOf(LF), -1, JSON.stringify(rec.warn[0]).slice(0, 220));
        assert.equal(rec.warn[0].split(BS + 'n' + FORGED).length - 1, 2, 'the name and the value, each with its break shown');
    });
});
