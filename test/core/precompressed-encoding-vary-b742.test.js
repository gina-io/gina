/**
 * #B742 + #B743 — a precompressed static's Content-Encoding and Vary: the source pins the live
 * test cannot see, and the shared `appendVary` helper driven on its EXTRACTED bytes (both engines).
 *
 * In production, HTTP/1.x statics (core/server.js handleStatics) and isaac's routing-table fast
 * path serve a precompressed copy (`app.js.br`, `app.js.gz`) when the request accepts its coding.
 *  - #B742: the copy went out labelled with its file EXTENSION without the dot (`gz`, `zip`), which
 *    is not a content coding, so a browser did not decode it. The label is now the coding's name
 *    (`gzip`), the value the request's Accept-Encoding matched.
 *  - #B743: the response carried no `Vary: Accept-Encoding`, so a shared cache could hand the
 *    compressed bytes to a client that did not accept them. Every production HTTP/1.x static now
 *    carries it, on the 200 AND the 304 (RFC 9110 § 15.4.5: a 304 carries the Vary its 200
 *    would), appended to any Vary already set; a configured `server.response.header` `vary`
 *    (which completeHeaders() sets on the 200 only) is merged before the conditional-GET decision
 *    and restored after completeHeaders(). HTTP/2 statics serve the file itself and stay without.
 *    isaac's routing table appends it after its own `Vary: Origin`, before its ETag 304.
 *
 * The behaviour a booted bundle shows is driven by
 * test/integration/container-boot-precompressed-b742.test.js. This file locks what that test cannot
 * see: where each statement sits, that the extension label is gone, and the helper's list
 * semantics.
 *
 * WHAT IT PINS / DRIVES
 *  §01 #B742 — both engines keep the matched coding's NAME beside its extension and send the name
 *      as Content-Encoding; the extension-derived label is gone from the code (comments kept the
 *      old statement as a `was:` line, checked to be there so the comment strip cannot pass the
 *      pin vacuously). CONTROL: the framework's own table maps gzip to `.gz`, so the old
 *      expression labelled gzip `gz`, while `br` was always right.
 *  §02 #B743 server.js — the production HTTP/1.x Vary block sits between the validators and the
 *      conditional-GET block, merging the configured `vary` from the block completeHeaders()
 *      iterates; the 200 restores what completeHeaders() replaced; the HTTP/2 200 adds none.
 *  §03 #B743 isaac — the routing table appends Accept-Encoding after `Vary: Origin`, production
 *      only, before its ETag 304.
 *  §04 appendVary, extracted from each engine and run on a fake response: append, keep, case-
 *      insensitive de-duplication, `*`, arrays, lists, the restore, empty input, sent headers; the
 *      two twins are identical code.
 *
 * Red-first: `GINA_B742_FW=<a tree holding the pre-change files at the framework's relative paths>`
 * runs every pin and arm against those bytes (jsdoc.md § "A module-path SEAM"); the arms named
 * CONTROL are expected green on both.
 *
 * Usage: node --test test/core/precompressed-encoding-vary-b742.test.js
 */
'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

// Module-path seam: every source is read under FW, so one variable points the whole file at
// pre-change copies.
var FW = process.env.GINA_B742_FW || require('../fw');

function read(rel) {
    return fs.readFileSync(path.join(FW, rel), 'utf8');
}

var SERVER   = read('core/server.js');
var ISAAC    = read('core/server.isaac.js');
var ENCODING = read('core/content.encoding');
var SETTINGS = read('core/template/conf/settings.json');

/** Collapse every whitespace run to one space (indentation and wraps are not the contract). */
function norm(s) {
    return s.replace(/\s+/g, ' ');
}

/** Block comments and whole-line `//` comments removed. */
function active(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
}

/** The normalised active code between two anchors, the start asserted present once. */
function region(src, start, end, label) {
    var a = src.indexOf(start);
    assert.ok(a > -1, label + ': the start anchor is present');
    assert.equal(src.indexOf(start, a + 1), -1, label + ': the start anchor is unique');
    var b = src.indexOf(end, a + start.length);
    assert.ok(b > a, label + ': the end anchor follows the start');
    return norm(active(src.slice(a, b)));
}

/** Index of a normalised needle in a normalised text (-1 when absent). */
function at(text, needle) {
    return text.indexOf(norm(needle));
}

function count(text, needle) {
    var n = norm(needle), c = 0, i = -1;
    while ( (i = text.indexOf(n, i + 1)) > -1 ) { c++; }
    return c;
}

/** Extract `<decl> … { … }` by a started-flag brace walk from its unique declaration. */
function extractBlock(src, decl, label) {
    var start = src.indexOf(decl);
    assert.ok(start > -1, label + ': the declaration is present (extraction control)');
    assert.equal(src.indexOf(decl, start + 1), -1, label + ': the declaration is unique');
    var i = start, depth = 0, started = false;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    assert.equal(depth, 0, label + ': balanced braces');
    return src.slice(start, i);
}

/** JSON with `//` and block comments, strings respected. */
function parseCommentedJSON(text) {
    var out = '', i = 0, inStr = false;
    while (i < text.length) {
        var ch = text[i], nx = text[i + 1];
        if (inStr) {
            out += ch;
            if (ch === '\\') { out += nx; i += 2; continue; }
            if (ch === '"') { inStr = false; }
            i++;
            continue;
        }
        if (ch === '"') { inStr = true; out += ch; i++; continue; }
        if (ch === '/' && nx === '/') { while (i < text.length && text[i] !== '\n') { i++; } continue; }
        if (ch === '/' && nx === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
        out += ch;
        i++;
    }
    return JSON.parse(out);
}

var STATICS     = function () { return region(SERVER, 'var handleStatics = function(staticProps, request, response, next) {', 'var onRequest = function() {', 'handleStatics'); };
var ROUTING     = function () { return region(ISAAC, 'request._ginaProxyPrefix = _xfp;', "var filename  =  _(localAsset.path +'/'+ localAsset.file, true);", 'isaac routing fast path'); };
var ROUTING_SIB = function () { return region(ISAAC, "var filename  =  _(localAsset.path +'/'+ localAsset.file, true);", 'if (!isBinary) {', 'isaac routing sibling'); };

var OLD_LABEL = String.raw`acceptEncoding.replace(/^\./, '')`;

// ─── §01 #B742 — the coding name, not the extension ─────────────────────────

describe('§01 #B742 — Content-Encoding names the coding, not the file extension', function () {

    it('01.1 server.js: the HTTP/1.x loop keeps the matched coding\'s name beside its extension', function () {
        assert.ok(at(STATICS(), String.raw`var acceptEncodingName = null; for (let e=0, eLen=preferedEncoding.length; e<eLen; e++) { if ( acceptEncodingArr && acceptEncodingArr.indexOf(preferedEncoding[e]) > -1 ) { acceptEncoding = bundleConf.server.coreConfiguration.encoding[ preferedEncoding[e] ] ; acceptEncodingName = preferedEncoding[e]; break; } }`) > -1);
    });

    it('01.2 server.js: the precompressed copy goes out as `content-encoding: <name>`', function () {
        assert.ok(at(STATICS(), String.raw`filename += acceptEncoding; response.setHeader('content-encoding', acceptEncodingName); var siblingStat = fs.statSync(filename);`) > -1);
    });

    it('01.3 isaac routing table: the same name capture and header', function () {
        var t = ROUTING_SIB();
        assert.ok(at(t, String.raw`var acceptEncodingName = null; if (acceptEncodingArr) { for (let e=0, eLen=preferedEncoding.length; e<eLen; e++) { if ( acceptEncodingArr && acceptEncodingArr.indexOf(preferedEncoding[e]) > -1 ) { acceptEncoding = options.coreConfiguration.encoding[ preferedEncoding[e] ] ; acceptEncodingName = preferedEncoding[e]; break; } } }`) > -1, 'the loop');
        assert.ok(at(t, String.raw`isBinary = true; filename += acceptEncoding; response.setHeader('content-encoding', acceptEncodingName);`) > -1, 'the header');
    });

    it('01.4 the extension-derived label is gone from both engines\' code (kept in a `was:` comment)', function () {
        [['core/server.js', SERVER], ['core/server.isaac.js', ISAAC]].forEach(function (f) {
            assert.equal(count(norm(active(f[1])), OLD_LABEL), 0, f[0] + ': no active statement derives the label from the extension');
            assert.ok(f[1].indexOf(OLD_LABEL) > -1, f[0] + ': the raw text still holds it in a comment (the strip is what removed it)');
        });
    });

    it('01.5 CONTROL — the framework table maps gzip to `.gz`: the old expression sent `gz`; `br` was always right', function () {
        var table = JSON.parse(ENCODING);
        var order = parseCommentedJSON(SETTINGS).server.preferedCompressionEncodingOrder;
        assert.ok(Array.isArray(order) && order.indexOf('gzip') > -1 && order.indexOf('br') > -1, 'the default order lists gzip and br');
        assert.equal(table.gzip, '.gz');
        assert.equal(table.gzip.replace(/^\./, ''), 'gz', 'what the old expression sent for gzip');
        assert.notEqual(table.gzip.replace(/^\./, ''), 'gzip');
        assert.equal(table.br.replace(/^\./, ''), 'br', 'br: the extension and the name agree');
    });
});

// ─── §02 #B743 — server.js handleStatics ─────────────────────────────────────

var VARY_BLOCK = String.raw`if ( !isCacheless && !/http\/2/.test(protocol) ) { var _varyConfHeader = ( bundleConf.server.response && bundleConf.server.response.header ) ? bundleConf.server.response.header : {}; for (let h in _varyConfHeader) { if ( /^vary$/i.test(h) ) { appendVary(response, _varyConfHeader[h]); } } appendVary(response, 'Accept-Encoding'); }`;

describe('§02 #B743 — handleStatics: Vary: Accept-Encoding on every production HTTP/1.x static', function () {

    it('02.1 the block sits right after the validators and right before the conditional-GET block (so the 304 carries it)', function () {
        assert.ok(at(STATICS(), String.raw`var etag = '"' + stat.size + '-' + stat.mtime.getTime() + '"'; ` + VARY_BLOCK + String.raw` if (!isCacheless) { versionRequested = lib.sri.getRequestedVersion(request.originalUrl || request.url);`) > -1);
    });

    it('02.2 it precedes every 304 of handleStatics', function () {
        var t = STATICS(), v = at(t, VARY_BLOCK), h1 = at(t, 'response.writeHead(304);');
        assert.ok(v > -1 && h1 > -1, 'anchors');
        assert.ok(v < h1, 'the Vary block < the HTTP/1.x 304');
    });

    it('02.3 CONTROL — completeHeaders() replaces each entry of `server.response.header` of the conf handleStatics reads (why the block merges it and the 200 restores)', function () {
        var ch = region(SERVER, 'var completeHeaders = function(responseHeaders, request, response) {', 'var getResponseProtocol = function (response) {', 'completeHeaders');
        assert.ok(at(ch, 'conf = self.conf[self.appName][self.env]') > -1, 'completeHeaders: conf is the bundle\'s env conf');
        assert.ok(at(ch, 'resHeaders = JSON.clone(conf.server.response.header);') > -1, 'completeHeaders copies server.response.header');
        assert.ok(at(ch, 'for (let h in resHeaders) {') > -1 && at(ch, 'response.setHeader(h, headerValue);') > -1, 'and sets each entry, replacing');
        assert.ok(at(STATICS(), 'bundleConf = conf[self.appName][self.env]') > -1, 'handleStatics: bundleConf is the same object');
    });

    it('02.4 the HTTP/1.x 200 restores what completeHeaders() replaced, production only', function () {
        assert.ok(at(STATICS(), String.raw`} else { var _varyBeforeComplete = response.getHeader('vary'); completeHeaders(null, request, response); if ( !isCacheless ) { appendVary(response, _varyBeforeComplete); } response.setHeader('content-type', contentType +'; charset='+ bundleConf.encoding);`) > -1);
    });

    it('02.5 appendVary is called three times in handleStatics (the configured value, Accept-Encoding, the restore)', function () {
        assert.equal(count(STATICS(), 'appendVary('), 3);
    });

    it('02.6 CONTROL — the HTTP/2 200 header object carries no Vary of its own (it serves the file itself)', function () {
        var t = STATICS();
        var a = at(t, String.raw`header = { ':status': 200, 'content-type': contentType + '; charset='+ bundleConf.encoding };`);
        var b = at(t, 'stream.respondWithFile(filename, header)');
        assert.ok(a > -1 && b > a, 'anchors');
        assert.equal(/vary/i.test(t.slice(a, b)), false);
    });
});

// ─── §03 #B743 — isaac's routing table ───────────────────────────────────────

describe('§03 #B743 — isaac routing table: Accept-Encoding after Vary: Origin', function () {

    it('03.1 appended after `Vary: Origin`, production only, before the cache headers', function () {
        assert.ok(at(ROUTING(), String.raw`response.setHeader('content-type', localAsset.mime); response.setHeader('vary', 'Origin'); if ( !isCacheless ) { appendVary(response, 'Accept-Encoding'); } response.setHeader('cache-control', ( request._ginaIsProxyHost === true ) ? 'private, no-cache' : 'public, no-cache');`) > -1);
    });

    it('03.2 before the ETag 304, so the 304 carries it', function () {
        var t = ROUTING();
        var v = at(t, String.raw`appendVary(response, 'Accept-Encoding');`);
        var nm = at(t, String.raw`if ( _routingAssetEtag && request.headers['if-none-match'] === _routingAssetEtag ) { response.statusCode = 304;`);
        assert.ok(v > -1 && nm > -1, 'anchors');
        assert.ok(v < nm);
    });
});

// ─── §04 appendVary, extracted ───────────────────────────────────────────────

var DECL = 'var appendVary = function(response, names) {';

/** The helper's own bytes, compiled alone: it reads nothing outside its parameters. */
function helperFrom(src, label) {
    var block = extractBlock(src, DECL, label);
    return new Function('return (' + block.replace(/^var appendVary = /, '') + ');')();
}

/** A response double: case-insensitive header map, counts setHeader calls. */
function fakeResponse(vary, sent) {
    var h = {}, sets = 0;
    if (typeof vary !== 'undefined') { h.vary = vary; }
    return {
        headersSent: !!sent,
        getHeader: function (n) { return h[String(n).toLowerCase()]; },
        setHeader: function (n, v) { sets++; h[String(n).toLowerCase()] = v; },
        vary: function () { return h.vary; },
        sets: function () { return sets; }
    };
}

/** [label, initial Vary, names, expected Vary, expected setHeader calls] */
var CASES = [
    ['no Vary yet: set',                                   undefined,                   'Accept-Encoding',              'Accept-Encoding',                 1],
    ['an empty Vary: set',                                 '',                          'Accept-Encoding',              'Accept-Encoding',                 1],
    ['appended to an existing value',                      'Origin',                    'Accept-Encoding',              'Origin, Accept-Encoding',         1],
    ['already listed, any case: kept, no write',           'Origin, accept-encoding',   'Accept-Encoding',              'Origin, accept-encoding',         0],
    ['`*` already varies on everything: no write',         '*',                         'Accept-Encoding',              '*',                               0],
    ['an array value read back from getHeader',            ['Origin', 'Cookie'],        'Accept-Encoding',              'Origin, Cookie, Accept-Encoding', 1],
    ['a list onto nothing',                                undefined,                   'Origin, Accept-Encoding',      'Origin, Accept-Encoding',         1],
    ['the restore: completeHeaders() left `Origin`',       'Origin',                    'Origin, Accept-Encoding',      'Origin, Accept-Encoding',         1],
    ['an array of names',                                  'Origin',                    ['Origin', 'Accept-Encoding'],  'Origin, Accept-Encoding',         1],
    ['undefined names: nothing',                           'Origin',                    undefined,                      'Origin',                          0],
    ['null names: nothing',                                'Origin',                    null,                           'Origin',                          0],
    ['blank names: nothing',                               'Origin',                    '  ',                           'Origin',                          0]
];

describe('§04 appendVary — driven on the extracted bytes of each engine', function () {

    [['core/server.js', function () { return SERVER; }], ['core/server.isaac.js', function () { return ISAAC; }]].forEach(function (engine) {

        CASES.forEach(function (c) {
            it('04 ' + engine[0] + ' — ' + c[0], function () {
                var appendVary = helperFrom(engine[1](), engine[0]);
                var res = fakeResponse(c[1]);
                appendVary(res, c[2]);
                assert.deepEqual(res.vary(), c[3]);
                assert.equal(res.sets(), c[4], 'setHeader calls');
            });
        });

        it('04 ' + engine[0] + ' — headers already sent: no write, no throw', function () {
            var appendVary = helperFrom(engine[1](), engine[0]);
            var res = fakeResponse('Origin', true);
            appendVary(res, 'Accept-Encoding');
            assert.equal(res.vary(), 'Origin');
            assert.equal(res.sets(), 0);
        });

        it('04 ' + engine[0] + ' — a response without getHeader/setHeader: no throw', function () {
            var appendVary = helperFrom(engine[1](), engine[0]);
            assert.doesNotThrow(function () { appendVary({}, 'Accept-Encoding'); });
            assert.doesNotThrow(function () { appendVary(null, 'Accept-Encoding'); });
        });
    });

    it('04.p the two twins are the same code (comments and whitespace aside)', function () {
        assert.equal(norm(active(extractBlock(ISAAC, DECL, 'isaac'))), norm(active(extractBlock(SERVER, DECL, 'server.js'))));
    });
});
