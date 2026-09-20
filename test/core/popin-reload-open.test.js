/**
 * #B579 — the declarative trigger's `loaded.<id>` listener applies a BODY, never a non-string detail
 *
 * `gina.popin.load(name, url)` on a popin that is already open lands through
 * `popinLoadContent(result, isRedirecting = true)`, which writes the body into the dialog and
 * then fires `loaded.<id>` with the POPIN OBJECT as detail — its legacy redirect emit, which the
 * legacy trigger's listener only binds and opens on. The declarative trigger (`data-gina-dialog`)
 * wires a different listener that APPLIES the detail through `handleLoadedBody` → `applyContent`,
 * and `applyContent` writes `''` for a non-string: the body just written was wiped and the open
 * dialog left empty (measured on the published bundle, no error anywhere).
 *
 * The fix is one guard in that listener: a non-string detail applies nothing. The live behaviour
 * is exercised by `test/e2e/popin-reload-open.spec.js` (a real engine, a real XHR); this file
 * pins the source shape and the served bundle.
 *
 * Red-first lever (source pins): GINA_POPIN_SRC=<path to a pre-fix copy of popin/main.js>
 *   node --test test/core/popin-reload-open.test.js   → the 01 pins go red, the CONTROL stays green.
 *
 * Usage: node --test test/core/popin-reload-open.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var POPIN_SRC = process.env.GINA_POPIN_SRC || path.join(FW, 'core/asset/plugin/src/vendor/gina/popin/main.js');
var DIST_JS   = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

var _src, _dist;
function getSrc()  { return _src  || (_src  = fs.readFileSync(POPIN_SRC, 'utf8')); }
function getDist() { return _dist || (_dist = fs.readFileSync(DIST_JS, 'utf8')); }

/** The declarative trigger's loaded-listener block: from its guard comment to the closing `});`. */
function listenerBlock(src) {
    var start = src.indexOf("if ( typeof(gina.events[loadedEvt]) == 'undefined' ) {");
    assert.ok(start > -1, 'the once-guarded declarative loaded.<id> registration is present');
    var end = src.indexOf('});', start);
    assert.ok(end > start, 'the registration closes');
    return src.slice(start, end + 3);
}


describe('01 - #B579: source pins', function () {

    it('the declarative loaded.<id> listener returns on a non-string detail BEFORE handleLoadedBody', function () {
        var block = listenerBlock(getSrc());
        assert.match(block, /if\s*\(\s*typeof\(loadedEvent\.detail\)\s*!=\s*'string'\s*\)\s*\{\s*\n\s*return;/,
            'expected the non-string guard in the declarative listener');
        var guardIdx = block.indexOf("typeof(loadedEvent.detail) != 'string'");
        var applyIdx = block.indexOf('handleLoadedBody(loadedEvent.detail, existing, ensurePopinDialog(existing));');
        assert.ok(applyIdx > -1, 'the listener still applies a body through handleLoadedBody');
        assert.ok(guardIdx > -1 && guardIdx < applyIdx, 'the guard precedes the apply');
    });

    it('CONTROL — true on both revisions: the listener applies through handleLoadedBody', function () {
        assert.ok(listenerBlock(getSrc()).indexOf('handleLoadedBody(loadedEvent.detail') > -1);
    });

    it('applyContent itself is untouched (it still blanks on a non-string — the guard lives in the listener)', function () {
        assert.match(getSrc(), /function applyContent\(\$el, html, \$popin, partialTarget\)\s*\{\s*\n\s*if\s*\(\s*!partialTarget\s*\)\s*\{\s*\n\s*\$el\.innerHTML\s*=\s*\(\s*typeof\(html\)\s*==\s*'string'\s*\)\s*\?\s*html\.trim\(\)\s*:\s*'';/,
            'applyContent keeps its shape');
    });
});


describe('02 - #B579: the built bundle carries the guard', function () {

    it('dist gina.js carries the non-string guard', function () {
        assert.ok(getDist().indexOf("typeof(loadedEvent.detail) != 'string'") > -1,
            'the guard is missing from dist gina.js — rebuild the bundle from source');
    });
});
