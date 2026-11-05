'use strict';
/**
 * #B1080 — `self.sendTrailers(fields)` records only the fields the HTTP/2 layer can send.
 *
 * The HTTP/2 compatibility response sends every recorded trailer field in ONE call after the body, and that call
 * throws on a field it cannot send, outside the render delegates' try/catch: the stream waits for its trailers and
 * never ends, or the error stops the bundle. `sendTrailers()` therefore keeps only a field whose name is an HTTP
 * token (RFC 9110 § 5.6.2) and is not connection-specific (RFC 9113 § 8.2.2: `connection`, `upgrade`,
 * `http2-settings`, `keep-alive`, `proxy-connection`, `transfer-encoding`, and `te` unless its value is `trailers`),
 * with a number value or a string value made only of a tab, U+0020 to U+007E and U+0080 to U+00FF (Node's
 * header-value rule), and records it under the name HTTP/2 sends (trimmed, lower-case). Pseudo-headers
 * (`:`-prefixed) are stripped, as before.
 *
 *   §01 the instrument: the REAL `this.sendTrailers = function(fields) {…};` block is lifted from controller.js
 *       and compiled with `new Function('local', 'self', …)`, so no replica can drift from the shipped bytes.
 *   §02 the record-time checks, on the lifted function: each kind of field the layer cannot send is dropped beside
 *       a valid one, a valid name is recorded trimmed and lower-case, and a call whose fields are all invalid
 *       records nothing. The arms labelled CONTROL pin what the change keeps.
 *   §03 differentials against the platform's own checks: over every ASCII character and five others placed inside
 *       a name, a name is kept exactly when `http.validateHeaderName` accepts it; over every character from U+0000
 *       to U+00FF and five others placed inside a value, a value is kept exactly when `http.validateHeaderValue`
 *       accepts it.
 *
 * The delivery of these fields over a booted HTTP/2 bundle is checked by
 * `test/integration/container-boot-h2-trailers-b1080.test.js` (its 01.8 arm).
 *
 * Red-first, against a tree without the change (read only, no write to it): point the seam at that tree's root,
 *   B1080_GINA_ROOT=/path/to/that/checkout node --test test/core/controller-send-trailers-b1080.test.js
 * Every arm not labelled CONTROL goes red; the CONTROL arms stay green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http   = require('http');

var ROOT   = process.env.B1080_GINA_ROOT || path.resolve(__dirname, '..', '..');
var PKG    = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
var SOURCE = path.join(ROOT, 'framework', 'v' + PKG.version, 'core', 'controller', 'controller.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');

var DECL = '    this.sendTrailers = function(fields) {';
var TAIL = '\n    };';
var OK   = { 'x-ok': '1' };

/**
 * The `sendTrailers` block of controller.js, from its declaration to its closing line.
 *
 * @inner
 * @param {string} src - the text of controller.js
 * @returns {string} the block, declaration and closing line included
 * @throws {Error} when the declaration is missing or not unique, or the block has no closing line
 */
function liftBlock(src) {
    var at = src.indexOf(DECL);
    if (at < 0) { throw new Error('the sendTrailers declaration was not found in ' + SOURCE); }
    if (src.indexOf(DECL, at + 1) > -1) { throw new Error('the sendTrailers declaration is not unique in ' + SOURCE); }
    var end = src.indexOf(TAIL, at);
    if (end < 0) { throw new Error('the sendTrailers block has no closing line in ' + SOURCE); }
    return src.slice(at, end + TAIL.length);
}

/**
 * A fresh `sendTrailers`, compiled from the lifted block, with its own `local` and `self`.
 *
 * @inner
 * @returns {{local: object, self: object, sendTrailers: function(*): object}} the function and what it closes over
 */
function makeEnv() {
    var local = {};
    var self  = { name: 'self' };
    var body  = liftBlock(SRC).replace(DECL, '    var sendTrailers = function(fields) {');
    var fn    = new Function('local', 'self', body + '\nreturn sendTrailers;')(local, self);
    return { local: local, self: self, sendTrailers: fn };
}

/**
 * What one call records: a fresh function is given `{ <name>: <value> }` beside the valid `x-ok: 1`.
 *
 * @inner
 * @param {string} name - the field name under test
 * @param {*} value - its value
 * @returns {?object} `local._trailers` after the call
 */
function recordBeside(name, value) {
    var env = makeEnv();
    var fields = { 'x-ok': '1' };
    fields[name] = value;
    env.sendTrailers(fields);
    return env.local._trailers;
}

/**
 * Whether the platform accepts a header name (`http.validateHeaderName` throws on a name that is not a token).
 *
 * @inner
 * @param {string} name - the header name
 * @returns {boolean} true when the platform accepts it
 */
function platformAccepts(name) {
    try { http.validateHeaderName(name); return true; } catch (e) { return false; }
}

/**
 * Whether the platform accepts a header value (`http.validateHeaderValue` throws on a character outside a tab,
 * U+0020 to U+007E and U+0080 to U+00FF).
 *
 * @inner
 * @param {string} value - the header value
 * @returns {boolean} true when the platform accepts it
 */
function platformAcceptsValue(value) {
    try { http.validateHeaderValue('x-v', value); return true; } catch (e) { return false; }
}


describe('01 - the instrument: the real sendTrailers block, lifted from controller.js', function () {

    it('01.1  CONTROL: the declaration is found once, its block has balanced braces, and it compiles to a function', function () {
        var block = liftBlock(SRC);
        assert.equal((block.match(/\{/g) || []).length, (block.match(/\}/g) || []).length, 'balanced braces');
        assert.equal(typeof makeEnv().sendTrailers, 'function');
    });

    it('01.2  CONTROL: the block keeps the pseudo-header strip, the local._trailers record and its return self', function () {
        var block = liftBlock(SRC);
        assert.deepEqual([block.indexOf("charAt(0) === ':'") > -1, block.indexOf('local._trailers') > -1, block.indexOf('return self') > -1], [true, true, true]);
    });
});


describe('02 - sendTrailers() records only the fields the HTTP/2 layer can send', function () {

    it('02.1  a valid field is recorded under the name HTTP/2 sends: trimmed and lower-case', function () {
        var env = makeEnv();
        var r = env.sendTrailers({ ' Grpc-Status ': '0', 'X-Digest': 'sha-256=abc' });
        assert.strictEqual(r, env.self);
        assert.deepEqual(env.local._trailers, { 'grpc-status': '0', 'x-digest': 'sha-256=abc' });
    });

    it('02.2  a name that is not an HTTP token is dropped, and the valid field beside it is kept', function () {
        var names = ['x(y)', 'bad field', 'x:y', 'x/y', 'x"y', 'xé', '', ' ', 'x\ty', 'x\r\ny'];
        assert.deepEqual(names.map(function (n) { return recordBeside(n, 'v'); }), names.map(function () { return OK; }));
    });

    it('02.3  CONTROL: a name made of every token character is kept as it was given', function () {
        var name = "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyz";
        var want = { 'x-ok': '1' };
        want[name] = 'v';
        assert.deepEqual(recordBeside(name, 'v'), want);
    });

    it('02.4  a connection-specific name is dropped whatever its case: connection, upgrade, http2-settings, keep-alive, proxy-connection, transfer-encoding', function () {
        var names = ['connection', 'Connection', 'UPGRADE', 'http2-settings', 'Keep-Alive', 'proxy-connection', 'Transfer-Encoding'];
        assert.deepEqual(names.map(function (n) { return recordBeside(n, 'close'); }), names.map(function () { return OK; }));
    });

    it('02.5  te is dropped unless its value is exactly trailers (gzip, Trailers, a list, an empty value)', function () {
        var values = ['gzip', 'Trailers', 'trailers, gzip', ''];
        assert.deepEqual(values.map(function (v) { return recordBeside('te', v); }), values.map(function () { return OK; }));
    });

    it('02.6  te: trailers is kept, under its lower-case name', function () {
        assert.deepEqual(recordBeside('TE', 'trailers'), { 'x-ok': '1', te: 'trailers' });
    });

    it('02.7  a value that is neither a string nor a number is dropped: an array, an object, null, undefined, a boolean, a function', function () {
        var values = [['a', 'b'], { a: 1 }, null, undefined, true, false, function () {}];
        assert.deepEqual(values.map(function (v) { return recordBeside('x-v', v); }), values.map(function () { return OK; }));
    });

    it('02.8  CONTROL: a number value and a string value are recorded as they were given', function () {
        var env = makeEnv();
        env.sendTrailers({ 'x-n': 7, 'x-s': '7' });
        assert.deepEqual(env.local._trailers, { 'x-n': 7, 'x-s': '7' });
    });

    it('02.9  CONTROL: pseudo-headers are stripped', function () {
        var env = makeEnv();
        env.sendTrailers({ ':status': '200', ':path': '/x', 'grpc-status': '0' });
        assert.deepEqual(env.local._trailers, { 'grpc-status': '0' });
    });

    it('02.10  a call whose fields the layer cannot send records nothing (null) and returns self', function () {
        var env = makeEnv();
        var r = env.sendTrailers({ 'x(y)': 'v', connection: 'close', 'x-a': ['a'], te: 'gzip' });
        assert.strictEqual(r, env.self);
        assert.strictEqual(env.local._trailers, null);
    });

    it('02.11  CONTROL: a call that is not given an object leaves the recorded set alone and returns self', function () {
        var env = makeEnv();
        env.sendTrailers({ 'x-ok': '1' });
        var set = env.local._trailers;
        var back = ['nope', null, undefined, 5, true].map(function (v) { return env.sendTrailers(v) === env.self; });
        assert.deepEqual(back, [true, true, true, true, true]);
        assert.strictEqual(env.local._trailers, set);
    });

    it('02.12  CONTROL: only the object\'s own fields are read, and a later call replaces the recorded set', function () {
        var env = makeEnv();
        var fields = Object.create({ 'x-inherited': '1' });
        fields['x-own'] = '2';
        env.sendTrailers(fields);
        assert.deepEqual(env.local._trailers, { 'x-own': '2' });
        env.sendTrailers({ 'x-next': '3' });
        assert.deepEqual(env.local._trailers, { 'x-next': '3' });
    });

    it('02.13  a string value holding a character outside Node\'s header-value rule is dropped (CR LF, CR, LF, NUL, U+0001, U+001F, DEL, U+20AC, an emoji), and the valid field beside it is kept', function () {
        var values = ['a\r\nb', 'a\rb', 'a\nb', 'a\u0000b', 'a\u0001b', 'a\u001fb', 'a\u007fb', 'a€b', 'a😀b'];
        assert.deepEqual(values.map(function (v) { return recordBeside('x-v', v); }), values.map(function () { return OK; }));
    });

    it('02.14  CONTROL: a string value made of a tab, a space, printable ASCII and U+0080 to U+00FF is kept as given, and so is an empty value', function () {
        var values = ['a\tb c', '!~ 09azAZ', 'a\u0080béÿ', ''];
        assert.deepEqual(values.map(function (v) { return recordBeside('x-v', v); }), values.map(function (v) { return { 'x-ok': '1', 'x-v': v }; }));
    });
});


describe('03 - the names kept are the names the platform accepts (http.validateHeaderName)', function () {

    it('03.1  CONTROL: the platform check fires both ways (x-ok accepted; x(y) and a name with a space refused)', function () {
        assert.deepEqual([platformAccepts('x-ok'), platformAccepts('x(y)'), platformAccepts('x y')], [true, false, false]);
    });

    it('03.2  each character U+0000 to U+007F, and five others, inside a name: kept exactly when the platform accepts the lower-case name', function () {
        var chars = [];
        for (var c = 0; c < 128; c++) { chars.push(String.fromCharCode(c)); }
        chars.push('é', 'ÿ', 'Ā', ' ', '😀');
        var kept = [], accepted = [];
        chars.forEach(function (ch) {
            var name = 'x' + ch + 'y';
            var env = makeEnv(), fields = {};
            fields[name] = 'v';
            env.sendTrailers(fields);
            kept.push(env.local._trailers !== null);
            accepted.push(platformAccepts(name.toLowerCase()));
        });
        assert.deepEqual(kept, accepted);
    });

    it('03.3  CONTROL: the platform value check fires both ways (a b accepted; a CR LF and a NUL refused)', function () {
        assert.deepEqual([platformAcceptsValue('a b'), platformAcceptsValue('a\r\nb'), platformAcceptsValue('a\u0000b')], [true, false, false]);
    });

    it('03.4  each character U+0000 to U+00FF, and five others, inside a value: kept exactly when the platform accepts the value', function () {
        var chars = [];
        for (var c = 0; c < 256; c++) { chars.push(String.fromCharCode(c)); }
        chars.push('Ā', '€', ' ', '﻿', '😀');
        var kept = [], accepted = [];
        chars.forEach(function (ch) {
            var value = 'a' + ch + 'b';
            var env = makeEnv();
            env.sendTrailers({ 'x-v': value });
            kept.push(env.local._trailers !== null);
            accepted.push(platformAcceptsValue(value));
        });
        assert.deepEqual(kept, accepted);
    });
});
