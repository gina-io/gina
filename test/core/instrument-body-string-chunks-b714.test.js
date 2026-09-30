'use strict';
/**
 * #B714 — the body reader of the `/_gina/maintenance` and `/_gina/instrument` POSTs must accept
 * a request whose encoding was set, and must never throw from its stream handlers.
 *
 * core/server.js `onInstance` calls `request.setEncoding(...)` for every non-multipart request,
 * so on the express engine a JSON-bodied POST to either endpoint reached `_readInstrumentBody`
 * as STRING chunks. `Buffer.concat` threw on them inside the `'end'` handler — an
 * uncaughtException that stopped the bundle (measured on the express engine). isaac answers
 * both endpoints itself, before core/server.js sets the encoding, so it read Buffers and was
 * not affected; its copy of the reader is a byte-identical twin and carries the same fix.
 *
 * The arms run the reader's OWN source text, extracted from each engine file and compiled with
 * `new Function` (it closes over nothing but globals), against a fake request; the real-stream
 * arm (04) runs it under a real `http` server in a child process, so a throw on the pre-fix
 * bytes fails that arm instead of stopping the test runner.
 *
 * Seams — run the whole file against other bytes (red-first, no tree revert):
 *   GINA_B714_SERVER_SRC=<core/server.js copy>  GINA_B714_ISAAC_SRC=<core/server.isaac.js copy>
 */

var { describe, it } = require('node:test');
var assert       = require('node:assert/strict');
var path         = require('path');
var fs           = require('fs');
var EventEmitter = require('events');
var { spawnSync } = require('child_process');

var FW = require('../fw');

var ENGINES = [
    { name: 'core/server.js',       src: fs.readFileSync(process.env.GINA_B714_SERVER_SRC || path.join(FW, 'core/server.js'), 'utf8') },
    { name: 'core/server.isaac.js', src: fs.readFileSync(process.env.GINA_B714_ISAAC_SRC  || path.join(FW, 'core/server.isaac.js'), 'utf8') }
];

var DECL = 'function _readInstrumentBody(req, cb) {';

/**
 * The reader's source text, declaration to closing brace.
 * @param {string} src engine source
 * @returns {string}
 */
function readerText(src) {
    var at = src.indexOf(DECL);
    assert.ok(at > -1, 'the engine must declare `' + DECL + '`');
    assert.equal(src.indexOf(DECL, at + 1), -1, 'one declaration');
    var end = src.indexOf('\n}\n', at);
    assert.ok(end > at, 'the declaration must close');
    return src.slice(at, end + 2);
}

/**
 * The reader compiled from its own source text.
 * @param {string} src engine source
 * @returns {function(object, function):void}
 */
function compileReader(src) {
    return new Function(readerText(src) + '\nreturn _readInstrumentBody;')();
}

/**
 * Feed `chunks` to the reader through a fake request, then end it. A throw from the `'end'`
 * handler is caught and reported, never propagated.
 * @param {function} read the compiled reader
 * @param {Array<string|Buffer>} chunks
 * @param {string} [encoding] the request's readableEncoding (set when chunks are strings)
 * @returns {{threw: (Error|null), calls: number, err: (Error|null), val: *, destroyed: boolean}}
 */
function drive(read, chunks, encoding) {
    var req = new EventEmitter();
    req.readableEncoding = encoding || null;
    req.destroyed = false;
    req.destroy = function () { req.destroyed = true; };
    var out = { threw: null, calls: 0, err: null, val: undefined, destroyed: false };
    read(req, function (err, val) { out.calls++; out.err = err || null; out.val = val; });
    try {
        chunks.forEach(function (c) { req.emit('data', c); });
        req.emit('end');
    } catch (e) {
        out.threw = e;
    }
    out.destroyed = req.destroyed;
    return out;
}

/** The body the arms send, split so that a chunk boundary falls inside the JSON. */
var BODY = '{"enable":true,"message":"été"}';


ENGINES.forEach(function (engine, e) {

    describe('0' + (e + 1) + ' - ' + engine.name + ' _readInstrumentBody', function () {

        it('0' + (e + 1) + '.1  parses a JSON body delivered as utf8 strings (it threw in the end handler)', function () {
            var r = drive(compileReader(engine.src), [BODY.slice(0, 10), BODY.slice(10)], 'utf8');
            assert.equal(r.threw, null, 'the end handler must not throw: ' + (r.threw && r.threw.message));
            assert.equal(r.calls, 1, 'one callback');
            assert.equal(r.err, null, 'no error: ' + (r.err && r.err.message));
            assert.deepEqual(r.val, { enable: true, message: 'été' });
        });

        it('0' + (e + 1) + '.2  control — the same body as Buffers parses the same way', function () {
            var buf = Buffer.from(BODY, 'utf8');
            var r = drive(compileReader(engine.src), [buf.subarray(0, 12), buf.subarray(12)]);
            assert.equal(r.threw, null);
            assert.equal(r.err, null);
            assert.deepEqual(r.val, { enable: true, message: 'été' });
        });

        it('0' + (e + 1) + '.3  the 4 KB cap counts BYTES of a string body', function () {
            // 2100 characters, 4200 bytes in utf8: over the cap in bytes, under it in characters
            var r = drive(compileReader(engine.src), ['"' + 'é'.repeat(2100) + '"'], 'utf8');
            assert.equal(r.threw, null, 'the end handler must not throw: ' + (r.threw && r.threw.message));
            assert.ok(r.err && r.err.message === 'body too large', 'expected `body too large`, got ' + (r.err ? r.err.message : JSON.stringify(r.val)));
            assert.equal(r.destroyed, true, 'the request must be destroyed past the cap');
        });

        it('0' + (e + 1) + '.4  answers invalid JSON in string chunks through the callback', function () {
            var r = drive(compileReader(engine.src), ['{"enable":'], 'utf8');
            assert.equal(r.threw, null, 'the end handler must not throw: ' + (r.threw && r.threw.message));
            assert.ok(r.err && r.err.message === 'invalid JSON body', 'expected `invalid JSON body`, got ' + (r.err ? r.err.message : 'no error'));
        });

        it('0' + (e + 1) + '.5  restores the original bytes from a latin1-decoded body', function () {
            var latin1 = Buffer.from(BODY, 'utf8').toString('latin1');
            var r = drive(compileReader(engine.src), [latin1], 'latin1');
            assert.equal(r.threw, null, 'the end handler must not throw: ' + (r.threw && r.threw.message));
            assert.deepEqual(r.val, { enable: true, message: 'été' });
        });

        it('0' + (e + 1) + '.6  control — an empty body answers {}', function () {
            var r = drive(compileReader(engine.src), [], 'utf8');
            assert.equal(r.threw, null);
            assert.deepEqual(r.val, {});
        });
    });
});

describe('03 - the two copies', function () {
    it('03.1  core/server.js and core/server.isaac.js carry the same reader', function () {
        assert.equal(readerText(ENGINES[0].src), readerText(ENGINES[1].src));
    });
});

describe('04 - a real request stream whose encoding was set', function () {
    it('04.1  a JSON POST read after request.setEncoding(\'utf8\') parses, and the stream really delivers strings', function () {
        var script = readerText(ENGINES[0].src) + '\n' + [
            "var http = require('http');",
            "var types = [];",
            "var server = http.createServer(function (req, res) {",
            "    req.setEncoding('utf8');",
            "    req.on('data', function (c) { types.push(typeof c); });",
            "    _readInstrumentBody(req, function (err, val) {",
            "        res.end(JSON.stringify({ err: err ? err.message : null, val: val, types: types }));",
            "    });",
            "});",
            "server.listen(0, '127.0.0.1', function () {",
            "    var body = " + JSON.stringify(BODY) + ";",
            "    var r = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/',",
            "        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, function (res) {",
            "        var d = ''; res.on('data', function (c) { d += c; });",
            "        res.on('end', function () { process.stdout.write(d); server.close(); });",
            "    });",
            "    r.end(body);",
            "});"
        ].join('\n');
        var child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
        assert.equal(child.status, 0, 'the child must exit cleanly (a throw in the reader stops it): ' + (child.stderr || '').slice(-600));
        var out = JSON.parse(child.stdout);
        assert.equal(out.err, null);
        assert.deepEqual(out.val, { enable: true, message: 'été' });
        assert.ok(out.types.length > 0 && out.types.every(function (t) { return t === 'string'; }), 'the premise: a stream with an encoding emits strings — ' + JSON.stringify(out.types));
    });
});
