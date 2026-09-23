'use strict';
/**
 * #B590 — a request-parsing failure logs METADATA, never the input.
 *
 * Pre-fix, the data helper's three catch blocks printed the unparsed document,
 * segment or value verbatim at error level: on the server that is the request
 * body or the whole serialized query string (a password, a token), and the
 * helper ships in the browser bundle, so the same lines reached the console.
 * `server.isaac.js`'s query parser warned with a query VALUE the same way.
 * Post-fix every site reports the input's length and the error's NAME only —
 * not `err.message` either: V8's JSON messages carry positions, but
 * JavaScriptCore's quote the offending token.
 *
 * Seams (red-first against `git show HEAD:` copies, no shared-tree touch):
 *   B590_DATA_SRC=<path>   the helpers/data/src/main.js copy to load and drive
 *   B590_ISAAC_SRC=<path>  the server.isaac.js copy the source pins read
 *
 * Run standalone: node --test test/lib/request-parsing-logs-b590.test.js
 */
var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var FW     = require('../fw');

var DATA_SRC  = process.env.B590_DATA_SRC  || path.join(FW, 'helpers', 'data', 'src', 'main.js');
var ISAAC_SRC = process.env.B590_ISAAC_SRC || path.join(FW, 'core', 'server.isaac.js');

require(path.resolve(DATA_SRC))();                       // installs the implicit globals
var formatDataFromString = global.formatDataFromString;

// --- log capture -------------------------------------------------------------

var captured = null, origError = null, origWarn = null;
function startCapture() {
    captured  = [];
    origError = console.error;
    origWarn  = console.warn;
    console.error = function () { captured.push(Array.prototype.slice.call(arguments).join(' ')); };
    console.warn  = function () { captured.push(Array.prototype.slice.call(arguments).join(' ')); };
}
function stopCapture() {
    if (origError) { console.error = origError; origError = null; }
    if (origWarn)  { console.warn  = origWarn;  origWarn  = null; }
}
function joined() { return captured.join('\n'); }

/** Comment-stripped code view (full-line `//` and `*`-led lines dropped, trailing `//` removed). */
function codeOnly(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
}

describe('01 - #B590: a document parse failure is reported without its content', function () {
    beforeEach(startCapture);
    afterEach(stopCapture);

    it('a malformed JSON document logs length + error name — not the body, not err.message', function () {
        var INPUT = '{"user":"u","password":"hunter2"';         // a text/plain login body, truncated
        var out = formatDataFromString(INPUT);
        assert.equal(out, undefined, 'the failure disposition is unchanged: undefined');
        assert.equal(captured.length, 1, 'exactly one line is logged, got: ' + JSON.stringify(captured));
        var line = captured[0];
        assert.ok(line.indexOf('[365] could not parse body') === 0, 'the [365] prefix survives (greppable): ' + line);
        assert.ok(line.indexOf(INPUT.length + ' chars') > -1, 'the length is reported: ' + line);
        assert.match(line, /\(SyntaxError\)/, 'the error NAME is reported: ' + line);
        assert.ok(line.indexOf('hunter2') < 0 && line.indexOf('password') < 0, 'the body must not be echoed: ' + line);
        assert.doesNotMatch(line, /position \d+/, 'err.message (which carries positions, and tokens on JavaScriptCore) is not logged: ' + line);
        assert.match(line, /, leading \{$/, 'the leading character class is the only content hint: ' + line);
    });

    it('the GET-document shape (a control character inside a serialized value) does not echo the query', function () {
        var INPUT = '{"token":"SECRET-QUERY-TOKEN-1 \n x","y":"1"}';    // a raw newline inside a JSON string
        var out = formatDataFromString(INPUT);
        assert.equal(out, undefined);
        assert.equal(captured.length, 1);
        assert.ok(joined().indexOf('SECRET-QUERY-TOKEN-1') < 0, 'the query value must not be echoed: ' + joined());
        assert.ok(joined().indexOf(INPUT.length + ' chars') > -1);
    });

    it('CONTROL: a valid document logs nothing and parses', function () {
        var out = formatDataFromString('{"a":"1","b":{"c":"2"}}');
        assert.deepEqual(out, { a: '1', b: { c: '2' } });
        assert.equal(captured.length, 0);
    });
});

describe('02 - #B590: urlencoded segment / value failures are not echoed either', function () {
    beforeEach(startCapture);
    afterEach(stopCapture);

    it('a JSON-leaning value that does not parse: the segment is not echoed, the other fields still parse', function () {
        var out = formatDataFromString('f={"k":"SECRET-VALUE-1"x&ok=1');
        assert.equal(out.ok, '1', 'the rest of the body still parses');
        assert.ok(joined().indexOf('SECRET-VALUE-1') < 0, 'the segment must not be echoed: ' + joined());
    });

    it('a value tripping the JSON probe: the value is not echoed', function () {
        var out = formatDataFromString('k=x{}":SECRET-VALUE-2&ok=1');
        assert.equal(out.ok, '1');
        assert.ok(joined().indexOf('SECRET-VALUE-2') < 0, 'the value must not be echoed: ' + joined());
    });

    it('CONTROL: a plain urlencoded body logs nothing', function () {
        var out = formatDataFromString('a=1&b=2');
        assert.deepEqual(out, { a: '1', b: '2' });
        assert.equal(captured.length, 0);
    });
});

describe('03 - #B590: source pins (comment-stripped, so the `// was:` records cannot trip them)', function () {
    var helperRaw  = fs.readFileSync(path.resolve(DATA_SRC), 'utf8');
    var helperCode = codeOnly(helperRaw);
    var isaacRaw   = fs.readFileSync(path.resolve(ISAAC_SRC), 'utf8');
    var isaacCode  = codeOnly(isaacRaw);

    it('helpers/data: no console.error call concatenates the parsed input', function () {
        assert.doesNotMatch(helperCode, /console\.error\([^;]*\+\s*(body|arr\[i\]|el\[1\])\s*\)/,
            'a log line must never carry the document / segment / value');
        // anti-vacuity: the stripped view actually removed the `// was:` records
        assert.ok(helperRaw.indexOf("could not parse body:\\n' + body") > -1, 'the raw source keeps the was: record');
        assert.ok(helperCode.indexOf("could not parse body:\\n' + body") < 0, 'the stripped view drops it');
    });

    it('helpers/data: every parse-failure line goes through describeParseFailure (length + error name)', function () {
        assert.match(helperCode, /var describeParseFailure\s*=\s*function\s*\(\s*input\s*,\s*err\s*\)/);
        var uses = helperCode.match(/describeParseFailure\(/g) || [];
        assert.ok(uses.length >= 2, 'the helper is defined once and used at least once: ' + uses.length);
        assert.match(helperCode, /console\.error\('\[365\] could not parse body: ' \+ describeParseFailure\(body, err\)/);
    });

    it('server.isaac.js: the not-JSON query warn names the key and the value LENGTH, never the value', function () {
        var site = isaacCode.indexOf('Could not convert to JSON or Array');
        assert.ok(site > -1, 'the warn site exists');
        var line = isaacCode.slice(isaacCode.lastIndexOf('\n', site) + 1, isaacCode.indexOf('\n', site));
        assert.doesNotMatch(line, /\+\s*a\[1\]\s*\+/, 'the value must not be concatenated: ' + line);
        assert.match(line, /a\[1\]\.length/, 'the length is what gets logged: ' + line);
        assert.match(line, /notAJsonError\.name/, 'the error NAME, not its message: ' + line);
        assert.doesNotMatch(line, /notAJsonError\.message/);
    });
});
