'use strict';
/**
 * #B765 — the automatic preload hints of an `http/2.0` bundle in production
 * (the `link` header of an HTML 200 and the 103 Early Hints sent before it) had
 * no size limit and no switch. Behind a reverse proxy whose response-header
 * buffer is smaller (nginx's `proxy_buffer_size`: one memory page, 4 KiB on
 * x86_64) a page with many declared assets or layout images answered 502. Fixed
 * in the same arc:
 *   #B767  a URL in both the templates.json list and the layout went out twice;
 *   #B771  the 103 also went out over HTTP/1.1, and nginx older than 1.29 takes
 *          an upstream 103 for the final response, so every page broke behind it;
 *   #B770  `setEarlyHints([a, b])` sent nothing over HTTP/1.1: node checks a
 *          string as ONE link value, and a ', '-joined list fails that check;
 *   #B772  a page whose own templates.json entry set a `_common` switch to
 *          `false` got `true` back (lib/merge returns `true` for merge(false, true));
 *   #B766  a stylesheet or script written in the layout never got an `as`, so
 *          never a hint.
 *
 * §01 drives the new helper, `core/controller/preload-hints.js`. §02 compiles the
 * REAL `setEarlyHints` out of controller.js and runs it against real node
 * HTTP/1.1 and HTTP/2 servers. §03 pins the one-line shaping in `render()` and
 * the HTTP/1.1 gate. §04 pins render-swig's shaping and executes its
 * build / shape / emit slice. §05 runs the real config.js page loop with the
 * real lib/merge. §06 runs the real `getAssets()`. §07 reads the framework
 * templates.json and the settings schema. The live readings (a real bundle behind
 * nginx 1.24 and 1.31 with Chromium) are the #B765 scene, not unit arms.
 *
 * Seams — point a section at a pre-change copy for a red-first run:
 * GINA_CONTROLLER_SRC, GINA_RENDER_SWIG_SRC, GINA_CONFIG_SRC, GINA_SERVER_SRC,
 * GINA_TEMPLATES_CONF, GINA_SETTINGS_SCHEMA; GINA_PRELOAD_HINTS points the whole
 * file at another copy of the helper (a mutation check of §01).
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs    = require('fs');
var path  = require('path');
var http  = require('http');
var http2 = require('http2');
var net   = require('net');

var FW   = require('../fw');
var ROOT = path.resolve(__dirname, '..', '..');

var CONTROLLER_SRC  = process.env.GINA_CONTROLLER_SRC  || path.join(FW, 'core/controller/controller.js');
var RENDER_SWIG_SRC = process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js');
var CONFIG_SRC      = process.env.GINA_CONFIG_SRC      || path.join(FW, 'core/config.js');
var SERVER_SRC      = process.env.GINA_SERVER_SRC      || path.join(FW, 'core/server.js');
var TEMPLATES_CONF  = process.env.GINA_TEMPLATES_CONF  || path.join(FW, 'core/template/conf/templates.json');
var SETTINGS_SCHEMA = process.env.GINA_SETTINGS_SCHEMA || path.join(ROOT, 'schema/settings.json');

var preloadHints = require(process.env.GINA_PRELOAD_HINTS || path.join(FW, 'core/controller/preload-hints'));
var merge        = require(path.join(FW, 'lib/merge'));

function count(haystack, needle) { return haystack.split(needle).length - 1; }

/** Remove block comments and whole-line `//` comments. @inner */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/mg, '');
}

/**
 * The text from a unique anchor to the brace that closes the first `{` after it.
 * Only used on code whose braces all balance outside strings and regexes (the
 * balance assertion catches the case where they do not).
 * @inner
 */
function braceBlock(src, anchor) {
    var at = src.indexOf(anchor);
    assert.ok(at > -1, 'anchor present: ' + anchor.slice(0, 70));
    assert.strictEqual(src.indexOf(anchor, at + 1), -1, 'anchor unique: ' + anchor.slice(0, 70));
    var depth = 0, i = src.indexOf('{', at);
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    assert.strictEqual(depth, 0, 'balanced braces after ' + anchor.slice(0, 70));
    return src.slice(at, i);
}

/** The text between two unique anchors (end excluded). @inner */
function between(src, startAnchor, endAnchor) {
    var at = src.indexOf(startAnchor);
    assert.ok(at > -1, 'start anchor present: ' + startAnchor.slice(0, 70));
    assert.strictEqual(src.indexOf(startAnchor, at + 1), -1, 'start anchor unique: ' + startAnchor.slice(0, 70));
    var end = src.indexOf(endAnchor, at);
    assert.ok(end > at, 'end anchor after the start: ' + endAnchor.slice(0, 70));
    return src.slice(at, end);
}

// gina's own form: entries joined with a bare ','
var CSS  = '</css/vendor/gina/gina.min.css?v=e602d1b9ee>; as=style; rel=preload';
var JS   = '</js/vendor/gina/gina.min.js?v=6a0bf42b46>; as=script; rel=preload';
var APP  = '</css/app.css?v=99bf1f0781>; as=style; rel=preload';

// ─── 01 — the helper ──────────────────────────────────────────────────────────

describe('01 - preload-hints helper (#B765 / #B767)', function () {

    it('01.1 splits gina\'s bare-comma form, a ", " list, and keeps an imagesrcset\'s commas in its entry', function () {
        assert.deepEqual(preloadHints.splitLinkEntries(CSS + ',' + JS), [CSS, JS]);
        assert.deepEqual(preloadHints.splitLinkEntries(CSS + ', ' + JS), [CSS, JS]);
        var img = '</img/a.png>; as=image; imagesrcset=/img/a.png 1x, /img/a@2x.png 2x; rel=preload';
        assert.deepEqual(preloadHints.splitLinkEntries(img + ',' + CSS), [img, CSS]);
        assert.deepEqual(preloadHints.splitLinkEntries(CSS + ','), [CSS], 'a trailing comma is dropped');
        assert.deepEqual(preloadHints.splitLinkEntries(''), []);
        assert.deepEqual(preloadHints.splitLinkEntries(undefined), []);
    });

    it('01.2 reads an entry\'s URL', function () {
        assert.equal(preloadHints.linkEntryUrl(CSS), '/css/vendor/gina/gina.min.css?v=e602d1b9ee');
        assert.equal(preloadHints.linkEntryUrl('rel=preload'), null);
    });

    it('01.3 under the cap and without duplicates, the value comes back byte-identical', function () {
        var v = CSS + ',' + JS + ',' + APP;
        assert.equal(preloadHints.shapeLinks(v, {}), v);
        assert.equal(preloadHints.shapeLinks(v, undefined), v);
    });

    it('01.4 drops an entry whose exact URL appeared earlier, first one wins, order kept (#B767)', function () {
        var dup = '</css/app.css?v=99bf1f0781>; as=fetch; rel=preload';
        assert.equal(preloadHints.shapeLinks(CSS + ',' + APP + ',' + JS + ',' + dup, {}), CSS + ',' + APP + ',' + JS);
        // a versioned and a plain URL are two URLs (both are fetched): both kept
        var plain = '</css/app.css>; as=style; rel=preload';
        assert.equal(preloadHints.shapeLinks(APP + ',' + plain, {}), APP + ',' + plain);
    });

    it('01.5 cuts at an entry boundary: exact fit kept, one byte over stops, never resumes with a smaller entry', function () {
        var a = '</a.css>; as=style; rel=preload';           // 31 bytes
        var b = '</b.css>; as=style; rel=preload';           // 31 bytes
        var big = '</' + 'x'.repeat(200) + '.css>; as=style; rel=preload';
        assert.equal(Buffer.byteLength(a), 31);
        assert.equal(preloadHints.shapeLinks(a + ',' + b, { preloadHintsMaxSize: 63 }), a + ',' + b, 'exact fit');
        assert.equal(preloadHints.shapeLinks(a + ',' + b, { preloadHintsMaxSize: 62 }), a, 'one byte over');
        assert.equal(preloadHints.shapeLinks(a + ',' + big + ',' + b, { preloadHintsMaxSize: 100 }), a, 'stops at the first entry that does not fit');
        assert.equal(preloadHints.shapeLinks(big + ',' + a, { preloadHintsMaxSize: 100 }), '', 'a first entry over the cap sends nothing');
        assert.equal(preloadHints.shapeLinks(a + ',' + big + ',' + b, { preloadHintsMaxSize: 0 }), a + ',' + big + ',' + b, '0 = no cap');
        var many = []; for (var i = 0; i < 100; i++) { many.push('</c' + i + '.css>; as=style; rel=preload'); }
        var out = preloadHints.shapeLinks(many.join(','), {});
        assert.ok(Buffer.byteLength(out) <= 1024 && Buffer.byteLength(out) > 900, 'default cap 1024: got ' + Buffer.byteLength(out));
    });

    it('01.6 counts bytes, not characters', function () {
        var e = '</é.css>; as=style; rel=preload';           // 31 characters, 32 bytes
        assert.equal(e.length, 31);
        assert.equal(preloadHints.shapeLinks(e, { preloadHintsMaxSize: 31 }), '');
        assert.equal(preloadHints.shapeLinks(e, { preloadHintsMaxSize: 32 }), e);
    });

    it('01.7 only `false` turns the hints off', function () {
        assert.equal(preloadHints.shapeLinks(CSS, { preloadHintsEnabled: false }), '');
        ['false', 0, null, undefined, true].forEach(function (v) {
            assert.equal(preloadHints.shapeLinks(CSS, { preloadHintsEnabled: v }), CSS, JSON.stringify(v) + ' keeps them on');
        });
    });

    it('01.8 an invalid size falls back to 1024 with ONE warning per process; absent or null falls back silently', function () {
        var warned = [], orig = console.warn;
        preloadHints._resetWarnings();
        console.warn = function (m) { warned.push(String(m)); };
        try {
            [-1, 1.5, '2048', NaN, Infinity, true, {}].forEach(function (v) {
                assert.equal(preloadHints.resolvePreloadHints({ preloadHintsMaxSize: v }).maxSize, 1024, JSON.stringify(v));
            });
            assert.equal(warned.length, 1, 'one warning for seven invalid values: ' + JSON.stringify(warned));
            assert.match(warned[0], /preloadHintsMaxSize/);
            assert.match(warned[0], /once per process/);
            preloadHints._resetWarnings(); warned.length = 0;
            assert.equal(preloadHints.resolvePreloadHints({}).maxSize, 1024);
            assert.equal(preloadHints.resolvePreloadHints({ preloadHintsMaxSize: null }).maxSize, 1024);
            assert.equal(preloadHints.resolvePreloadHints({ preloadHintsMaxSize: 0 }).maxSize, 0);
            assert.equal(preloadHints.resolvePreloadHints({ preloadHintsMaxSize: 4096 }).maxSize, 4096);
            assert.equal(warned.length, 0, 'no warning for valid or absent sizes');
        } finally {
            console.warn = orig;
            preloadHints._resetWarnings();
        }
    });

    it('01.9 toEarlyHintsList: one array element per entry, falsy elements dropped, the cap counted on node\'s ", " join', function () {
        assert.deepEqual(preloadHints.toEarlyHintsList([CSS, null, '', JS], {}), [CSS, JS]);
        assert.deepEqual(preloadHints.toEarlyHintsList(CSS + ',' + JS, {}), [CSS, JS], 'a string holding two entries');
        var a = '</a.css>; as=style; rel=preload', b = '</b.css>; as=style; rel=preload';
        assert.deepEqual(preloadHints.toEarlyHintsList([a, b], { preloadHintsMaxSize: 64 }), [a, b], '31 + 2 + 31');
        assert.deepEqual(preloadHints.toEarlyHintsList([a, b], { preloadHintsMaxSize: 63 }), [a]);
        assert.deepEqual(preloadHints.toEarlyHintsList([a, b], { preloadHintsMaxSize: 63, preloadHintsEnabled: false }), [a], 'the switch is for the automatic hints only');
    });
});

// ─── 02 — the real setEarlyHints, against real node servers ──────────────────

describe('02 - setEarlyHints over real HTTP/1.1 and HTTP/2 (#B771 / #B770)', function () {
    var make, h1, h2, h1Port, h2Port;
    var ARMS = {};

    /** The real function, compiled out of the source with its closure names supplied. @inner */
    function compile() {
        var src   = fs.readFileSync(CONTROLLER_SRC, 'utf8');
        var block = braceBlock(src, 'this.setEarlyHints = function(links) {');
        var fnSrc = block.slice(block.indexOf('function(links)'));
        return function (local) {
            var self = { name: 'self' };
            function headersSent(r) { return !!(r && (r.headersSent || (r.stream && r.stream.headersSent))); }
            return { self: self, fn: new Function('self', 'local', 'headersSent', 'preloadHints', 'return (' + fnSrc + ');')(self, local, headersSent, preloadHints) };
        };
    }

    function handler(req, res) {
        var arm = ARMS[req.url.slice(1)];
        var local = { res: res, options: { conf: { server: arm.server }, template: arm.template || {} } };
        var c = make(local);
        var ret = c.fn(arm.links);
        res.setHeader('x-returned-self', String(ret === c.self));
        res.end('ok');
    }

    /** Raw HTTP/1.1 GET: every informational response's Link, then the final status and body. @inner */
    function rawGet(armId) {
        return new Promise(function (resolve) {
            var buf = '', done = false;
            var s = net.connect(h1Port, '127.0.0.1', function () { s.write('GET /' + armId + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'); });
            var finish = function () {
                if (done) { return; } done = true; clearTimeout(t);
                var hints = [], at = 0, final = null;
                while (true) {
                    var e = buf.indexOf('\r\n\r\n', at); if (e < 0) { break; }
                    var head = buf.slice(at, e), status = Number(head.slice(9, 12));
                    if (status >= 100 && status < 200) { var m = /\r\nlink: ([^\r\n]*)/i.exec(head); hints.push(m ? m[1] : null); at = e + 4; continue; }
                    final = { status: status, self: (/\r\nx-returned-self: (\w+)/i.exec(head) || [])[1], body: buf.slice(e + 4) };
                    break;
                }
                resolve({ hints: hints, final: final, raw: buf });
            };
            s.on('data', function (d) { buf += d; }); s.on('close', finish); s.on('error', finish);
            var t = setTimeout(function () { s.destroy(); finish(); }, 5000);
        });
    }

    /** HTTP/2 GET (cleartext): every informational response's link, then the final status. @inner */
    function h2Get(armId) {
        return new Promise(function (resolve) {
            var client = http2.connect('http://127.0.0.1:' + h2Port), hints = [], status = null, self = null, body = '', done = false;
            var finish = function (err) {
                if (done) { return; } done = true; clearTimeout(t);
                try { client.close(); } catch (e) { /* gone */ }
                resolve({ hints: hints, final: { status: status, self: self, body: body }, error: err && (err.code || err.message) });
            };
            client.on('error', finish);
            var r = client.request({ ':path': '/' + armId });
            r.on('headers', function (h) { if (h[':status'] >= 100 && h[':status'] < 200) { hints.push(h.link); } });
            r.on('response', function (h) { status = h[':status']; self = h['x-returned-self']; });
            r.setEncoding('utf8'); r.on('data', function (d) { body += d; });
            r.on('end', function () { finish(); }); r.on('error', finish);
            var t = setTimeout(function () { finish(new Error('timeout')); }, 5000);
            r.end();
        });
    }

    var A = '</css/a.css?v=0123456789>; rel=preload; as=style', B = '</css/b.css?v=abcdef0123>; rel=preload; as=style', C = '</js/c.js?v=fedcba9876>; rel=preload; as=script';

    before(async function () {
        make = compile();
        ARMS = {
            'default-auto'   : { server: {},                              links: A + ',' + B },
            'default-array'  : { server: {},                              links: [A, B] },
            'on-array'       : { server: { earlyHintsOverHTTP1: true },   links: [A, B] },
            'on-auto'        : { server: { earlyHintsOverHTTP1: true },   links: A + ',' + B },
            'on-capped'      : { server: { earlyHintsOverHTTP1: true },   links: [A, B, C], template: { preloadHintsMaxSize: Buffer.byteLength(A) + 2 + Buffer.byteLength(B) } },
            'on-string-true' : { server: { earlyHintsOverHTTP1: 'true' }, links: A + ',' + B },
            'h2-array'       : { server: {},                              links: [A, B] },
            'h2-over-cap'    : { server: {},                              links: [A, B, C], template: { preloadHintsMaxSize: Buffer.byteLength(A) } }
        };
        h1 = http.createServer(handler);
        h2 = http2.createServer();
        h2.on('request', handler);
        await new Promise(function (resolve) { h1.listen(0, '127.0.0.1', resolve); });
        await new Promise(function (resolve) { h2.listen(0, '127.0.0.1', resolve); });
        h1Port = h1.address().port;
        h2Port = h2.address().port;
    });
    after(async function () {
        await new Promise(function (resolve) { h1.close(resolve); });
        await new Promise(function (resolve) { h2.close(resolve); });
    });

    it('02.1 HTTP/1.1, setting absent: gina\'s automatic form sends NO 103; the page itself is untouched (#B771)', async function () {
        var r = await rawGet('default-auto');
        assert.deepEqual(r.hints, [], 'no 103: ' + JSON.stringify(r.raw.slice(0, 200)));
        assert.equal(r.final.status, 200); assert.equal(r.final.body, 'ok'); assert.equal(r.final.self, 'true');
    });

    it('02.2 HTTP/1.1, setting absent: an explicit array sends NO 103 either', async function () {
        var r = await rawGet('default-array');
        assert.deepEqual(r.hints, []);
        assert.equal(r.final.status, 200);
    });

    it('02.3 HTTP/1.1, `earlyHintsOverHTTP1: true`: the docs\' two-entry array arrives, both entries (#B770)', async function () {
        var r = await rawGet('on-array');
        assert.deepEqual(r.hints, [A + ', ' + B]);
        assert.equal(r.final.status, 200); assert.equal(r.final.body, 'ok');
    });

    it('02.4 HTTP/1.1, the setting on: gina\'s bare-comma string goes to node as an array (node joins it with ", ")', async function () {
        var r = await rawGet('on-auto');
        assert.deepEqual(r.hints, [A + ', ' + B]);
    });

    it('02.5 HTTP/1.1, the setting on: the 103 stops at the page\'s preloadHintsMaxSize, counted on node\'s join', async function () {
        var r = await rawGet('on-capped');
        assert.deepEqual(r.hints, [A + ', ' + B], 'the third entry does not fit');
    });

    it('02.6 HTTP/1.1: the setting must be the boolean true — the string "true" sends no 103', async function () {
        var r = await rawGet('on-string-true');
        assert.deepEqual(r.hints, []);
        assert.equal(r.final.status, 200);
    });

    it('02.7 HTTP/2 (control): an explicit array is one 103, its entries joined with ", " — unchanged', async function () {
        var r = await h2Get('h2-array');
        assert.equal(r.error, undefined);
        assert.deepEqual(r.hints, [A + ', ' + B]);
        assert.equal(r.final.status, 200); assert.equal(r.final.body, 'ok'); assert.equal(r.final.self, 'true');
    });

    it('02.8 HTTP/2: an explicit call is not capped — the cap is for the automatic hints and the HTTP/1.1 path', async function () {
        var r = await h2Get('h2-over-cap');
        assert.deepEqual(r.hints, [A + ', ' + B + ', ' + C]);
    });
});

// ─── 03 — controller.js: render()'s shaping and the HTTP/1.1 gate ─────────────

describe('03 - controller.js wiring (#B765 / #B771)', function () {
    var SRC, stripped;
    before(function () { SRC = fs.readFileSync(CONTROLLER_SRC, 'utf8'); stripped = stripComments(SRC); });

    it('03.1 the module loads the helper', function () {
        assert.match(stripped, /\nvar preloadHints\s*=\s*require\('\.\/preload-hints'\);/);
    });

    it('03.2 render() shapes the 103 between the trim and the unchanged setEarlyHints(_hints), with the error page\'s template on a custom-error render', function () {
        assert.match(stripped, /var _hints = \/,\$\/\.test\(_h2Links\) \? _h2Links\.slice\(0, -1\) : _h2Links;\s*_hints = preloadHints\.shapeLinks\(_hints, \(errOptions\) \? errOptions\.template : local\.options\.template\);\s*if \(_hints\) self\.setEarlyHints\(_hints\);/);
        assert.equal(count(stripped, 'preloadHints.shapeLinks('), 1, 'one shaping call in controller.js');
    });

    it('03.3 setEarlyHints sends over HTTP/1.1 only when server.earlyHintsOverHTTP1 is true, as the helper\'s list', function () {
        var block = stripComments(braceBlock(SRC, 'this.setEarlyHints = function(links) {'));
        assert.match(block, /typeof _res\.writeEarlyHints === 'function'\s*&& local\.options\.conf\.server\.earlyHintsOverHTTP1 === true/);
        assert.match(block, /var _entries = preloadHints\.toEarlyHintsList\(links, local\.options\.template\);/);
        assert.match(block, /_res\.writeEarlyHints\(\{ 'link': _entries \}\);/);
        assert.equal(count(block, "_res.writeEarlyHints({ 'link': _link });"), 0, 'the string form is gone');
    });

    it('03.4 premise (both revisions): the HTTP/2 branch is unchanged', function () {
        var block = braceBlock(SRC, 'this.setEarlyHints = function(links) {');
        assert.equal(count(block, "_res.stream.additionalHeaders({ ':status': 103, 'link': _link });"), 1);
    });
});

// ─── 04 — render-swig: the 200 header's shaping ───────────────────────────────

describe('04 - controller.render-swig.js: the 200 link header (#B765 / #B767)', function () {
    var SRC, stripped, run, build;

    var BUILD = '_h2PreloadLinks = buildH2PreloadLinks(localOptions.template.h2Links, localOptions.template.assets);';
    var EMIT  = "res.setHeader('link', _h2PreloadLinks);";

    before(function () {
        SRC = fs.readFileSync(RENDER_SWIG_SRC, 'utf8');
        stripped = stripComments(SRC);
        // The compile path's build / shape / emit slice, executed with stubs.
        var at  = SRC.indexOf(BUILD);
        var end = SRC.indexOf('}', SRC.indexOf(EMIT, at)) + 1;
        var slice = SRC.slice(at, end);
        run = new Function('buildH2PreloadLinks', 'preloadHints', 'localOptions', 'self', 'res',
            'var _h2PreloadLinks = null;\n' + slice + '\nreturn _h2PreloadLinks;');
        build = new Function('return (' + braceBlock(SRC, 'function buildH2PreloadLinks(h2Links, assets) {') + ');')();
    });

    /** Run the slice; returns the memoised value and the header the response got. @inner */
    function emit(template) {
        var headers = {};
        var res  = { setHeader: function (k, v) { headers[k] = v; } };
        var self = { isXMLRequest: function () { return false; }, isCacheless: function () { return false; } };
        var memo = run(build, preloadHints, { template: template }, self, res);
        return { memo: memo, header: headers.link };
    }

    it('04.1 the module loads the helper', function () {
        assert.match(stripped, /\nvar preloadHints\s*=\s*require\('\.\/preload-hints'\);/);
    });

    it('04.2 the shaping sits between the unchanged build line and the unchanged emission gate', function () {
        assert.match(stripped, /_h2PreloadLinks = buildH2PreloadLinks\(localOptions\.template\.h2Links, localOptions\.template\.assets\);\s*_h2PreloadLinks = preloadHints\.shapeLinks\(_h2PreloadLinks, localOptions\.template\);\s*if \( !self\.isXMLRequest\(\) && !self\.isCacheless\(\) && _h2PreloadLinks \) \{/);
    });

    it('04.3 executed: a value over the page\'s cap is cut at an entry boundary, and the memo holds what was sent', function () {
        var prefix = CSS + ',' + JS + ',', map = {};
        for (var i = 0; i < 40; i++) { map['/img/b765-' + i + '.png'] = { as: 'image', isAvailable: true }; }
        var full = build(prefix, map);
        assert.ok(Buffer.byteLength(full) > 1024, 'premise: the unshaped header is over 1024 bytes (' + Buffer.byteLength(full) + ')');
        var r = emit({ h2Links: prefix, assets: map, preloadHintsMaxSize: 512 });
        assert.ok(Buffer.byteLength(r.header) <= 512, 'header ' + Buffer.byteLength(r.header) + ' bytes');
        assert.ok(full.indexOf(r.header + ',') === 0, 'a prefix of the full value, cut before an entry');
        assert.equal(r.memo, r.header, 'the cache entry memoises the shaped value');
    });

    it('04.4 executed: `preloadHintsEnabled: false` sends no header and memoises an empty one', function () {
        var r = emit({ h2Links: CSS + ',', assets: {}, preloadHintsEnabled: false });
        assert.equal(r.header, undefined);
        assert.equal(r.memo, '');
    });

    it('04.5 executed (control): a short value goes out byte-identical to what buildH2PreloadLinks assembled', function () {
        var map = { '/img/a.png': { as: 'image', isAvailable: true } };
        var r = emit({ h2Links: CSS + ',', assets: map });
        assert.equal(r.header, build(CSS + ',', map));
    });
});

// ─── 05 — config.js: a page's own boolean (#B772) ─────────────────────────────

describe('05 - config.js page loop keeps a page\'s own boolean (#B772)', function () {
    var loop;
    before(function () {
        var src  = fs.readFileSync(CONFIG_SRC, 'utf8');
        var body = between(src, "for (let ref in files['templates']._common) {", '// removes common definitions from the common definitions of the current section');
        loop = new Function('files', 'section', 'merge', body + '\nreturn files.templates[section];');
    });

    function page(own) {
        var common = { assetVersioningEnabled: true, preloadHintsEnabled: true, javascriptsDeferEnabled: true, sriEnabled: false, preloadHintsMaxSize: 1024, 'http-metas': { 'content-type': 'text/html' }, stylesheets: [], javascripts: [] };
        return loop({ templates: { _common: common, pg: own } }, 'pg', merge);
    }

    it('05.1 a page\'s `false` over `_common`\'s `true` stays `false`', function () {
        var p = page({ assetVersioningEnabled: false, preloadHintsEnabled: false, javascriptsDeferEnabled: false });
        assert.equal(p.assetVersioningEnabled, false);
        assert.equal(p.preloadHintsEnabled, false);
        assert.equal(p.javascriptsDeferEnabled, false);
    });

    it('05.2 controls: `true` over `false`, numbers, an absent key, and an object (still merged)', function () {
        var p = page({ sriEnabled: true, preloadHintsMaxSize: 0, 'http-metas': { 'x-a': '1' } });
        assert.equal(p.sriEnabled, true);
        assert.equal(p.preloadHintsMaxSize, 0);
        assert.equal(page({ preloadHintsMaxSize: 2048 }).preloadHintsMaxSize, 2048);
        assert.equal(page({}).preloadHintsEnabled, true, 'an absent key is copied');
        assert.deepEqual(p['http-metas'], { 'x-a': '1', 'content-type': 'text/html' }, 'an object is merged as before');
        assert.equal(p.stylesheets, undefined, 'the asset lists are not handled by this loop');
    });
});

// ─── 06 — server.js getAssets(): layout stylesheets and scripts (#B766) ──────

describe('06 - getAssets() gives a layout stylesheet / script its `as` (#B766)', function () {
    var map, link;

    var LAYOUT = [
        '<!DOCTYPE html>',
        '<html><head>',
        '<link rel="stylesheet" href="/css/a.css">',
        '<link rel="stylesheet" href="/css/scr.css" media="screen">',
        '<link rel="stylesheet" href="/css/all.css" media="all">',
        '<link rel="stylesheet" href="/css/print.css" media="print">',
        '<link rel="stylesheet" href="/css/sri.css" integrity="sha384-abc" crossorigin="anonymous">',
        '<link rel="stylesheet alternate" href="/css/alt.css" title="alt">',
        '<link rel="alternate stylesheet" href="/css/alt2.css" title="alt2">',
        '<link rel="icon" href="/favicon.ico">',
        '<script src="/js/b.js"></script>',
        '<script defer src="/js/d.js"></script>',
        '<script src="/js/cors.js" crossorigin></script>',
        '<script type="module" src="/js/mod.js"></script>',
        '<script nomodule src="/js/legacy.js"></script>',
        '<script>var inline = 1;</script>',
        '<link rel="stylesheet" href="/css/x.css"><img src="/img/b.png">',
        '<link rel="stylesheet" href="/css/wide-sri.css" media="(width > 600px)" integrity="sha384-abc" crossorigin="anonymous">',
        '<link rel="stylesheet" href="/css/wide.css" media="(width >= 900px)">',
        '<script src="/js/cors2.js" data-note="a>b" crossorigin></script>',
        '</head><body>',
        '<img src="/img/c.png">',
        '</body></html>'
    ].join('\n');

    before(function () {
        var src  = fs.readFileSync(SERVER_SRC, 'utf8');
        var body = between(src, 'var getAssets = function (bundleConf, layoutStr, swig, data) {', '// var getHeaderFromPseudoHeader = function(header) {');
        body = body.slice(body.indexOf('function ('), body.lastIndexOf('}') + 1);
        var helper = ( src.indexOf('var isPreloadableLayoutTag = function') > -1 )
            ? new Function('return (' + braceBlock(src, 'var isPreloadableLayoutTag = function').replace(/^var isPreloadableLayoutTag = /, '') + ');')()
            : undefined;   // a pre-change copy has none, and its getAssets() never calls it
        var getAssets = new Function('fs', 'getAssetFilenameFromUrl', 'isPreloadableLayoutTag', 'return (' + body + ');')(
            fs, function (conf, url) { return '/b765/public' + url; }, helper);
        var conf = { host: 'localhost', encoding: 'utf8', server: { coreConfiguration: { mime: { css: 'text/css', js: 'application/javascript', png: 'image/png', ico: 'image/x-icon' } } } };
        map  = JSON.parse(getAssets(conf, LAYOUT, null, null));
        var swigSrc = fs.readFileSync(RENDER_SWIG_SRC, 'utf8');
        var build = new Function('return (' + braceBlock(swigSrc, 'function buildH2PreloadLinks(h2Links, assets) {') + ');')();
        link = build('', map);
    });

    it('06.1 a stylesheet on its own line gets `as=style`, `media` all or screen included', function () {
        assert.equal(map['/css/a.css'].as, 'style');
        assert.equal(map['/css/scr.css'].as, 'style');
        assert.equal(map['/css/all.css'].as, 'style');
    });

    it('06.2 a script with a `src` gets `as=script`, `defer` included', function () {
        assert.equal(map['/js/b.js'].as, 'script');
        assert.equal(map['/js/d.js'].as, 'script');
    });

    it('06.3 no `as` where a preload could not be matched to the tag: print media, integrity, crossorigin, module, nomodule, alternate', function () {
        ['/css/print.css', '/css/sri.css', '/css/alt.css', '/js/cors.js', '/js/mod.js', '/js/legacy.js'].forEach(function (u) {
            assert.ok(map[u], u + ' is in the map');
            assert.equal(map[u].as, null, u);
        });
    });

    it('06.4 tags sharing a line each get their own entry (#B768): the stylesheet as=style, the image as=image', function () {
        assert.equal(map['/css/x.css'] && map['/css/x.css'].as, 'style');
        assert.equal(map['/img/b.png'] && map['/img/b.png'].as, 'image');
    });

    it('06.5 controls: an image keeps `as=image`; an icon, an inline script and rel="alternate stylesheet" never enter the map', function () {
        assert.equal(map['/img/c.png'].as, 'image');
        assert.equal(map['/favicon.ico'], undefined);
        assert.equal(map['/css/alt2.css'], undefined, 'the layout scan only takes a rel that starts with stylesheet');
    });

    it('06.6 end to end: the 200 header built from that map names the layout stylesheet and script, and none of the skipped files', function () {
        assert.ok(link.indexOf('</img/c.png>; as=image; rel=preload') > -1, 'control: the image is hinted');
        assert.ok(link.indexOf('</css/a.css>; as=style; rel=preload') > -1, link);
        assert.ok(link.indexOf('</js/b.js>; as=script; rel=preload') > -1, link);
        ['/css/print.css', '/css/sri.css', '/css/alt.css', '/js/cors.js', '/js/mod.js', '/js/legacy.js'].forEach(function (u) {
            assert.equal(link.indexOf('<' + u + '>'), -1, u + ' is not hinted');
        });
    });

    it('06.7 a `>` inside a quoted attribute value does not end the tag: the integrity, crossorigin and media after it still count', function () {
        assert.equal(map['/css/a.css'].as, 'style', 'control: a plain layout stylesheet');
        ['/css/wide-sri.css', '/css/wide.css', '/js/cors2.js'].forEach(function (u) {
            assert.ok(map[u], u + ' is in the map');
            assert.equal(map[u].as, null, u);
            assert.equal(link.indexOf('<' + u + '>'), -1, u + ' is not hinted');
        });
    });
});

// ─── 07 — the defaults: templates.json and the settings schema ────────────────

describe('07 - the declared defaults', function () {

    /** Strip line and block comments outside strings, then JSON.parse. @inner */
    function parseJSONC(text) {
        var out = '', i = 0, inStr = false;
        while (i < text.length) {
            var ch = text[i], next = text[i + 1];
            if (inStr) { out += ch; if (ch === '\\') { out += next; i += 2; continue; } if (ch === '"') { inStr = false; } i++; continue; }
            if (ch === '"') { inStr = true; out += ch; i++; continue; }
            if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') { i++; } continue; }
            if (ch === '/' && next === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
            out += ch; i++;
        }
        return JSON.parse(out);
    }

    it('07.1 the framework templates.json declares preloadHintsEnabled: true and preloadHintsMaxSize: 1024 in _common', function () {
        var conf = parseJSONC(fs.readFileSync(TEMPLATES_CONF, 'utf8'));
        assert.equal(conf._common.assetVersioningEnabled, true, 'control: a key the file already declared');
        assert.equal(conf._common.preloadHintsEnabled, true);
        assert.equal(conf._common.preloadHintsMaxSize, 1024);
    });

    it('07.2 the settings schema declares server.earlyHintsOverHTTP1 as a boolean, false by default', function () {
        var schema = JSON.parse(fs.readFileSync(SETTINGS_SCHEMA, 'utf8'));
        var server = schema.properties.server.properties;
        assert.equal(server.allowHTTP1.type, 'boolean', 'control: a key the schema already declared');
        assert.ok(server.earlyHintsOverHTTP1, 'declared');
        assert.equal(server.earlyHintsOverHTTP1.type, 'boolean');
        assert.equal(server.earlyHintsOverHTTP1.default, false);
    });
});
