'use strict';
/**
 * #B873 — controller.render-swig.js treated a render as a custom-error render when the RENDER DATA
 * carried `isRenderingCustomError` ('true' or true, any case) as well as when the render options
 * did. An action that renders request data (`self.render(req.get)`) therefore let a request value
 * `?isRenderingCustomError=true` switch its page into the error-page mode: the view is then taken
 * as an error-page file, and the containment guard answered 500 (measured on a booted bundle,
 * 2026-10-29). Every gina error page renders through `renderCustomError`, the control of the
 * `custom-error-page` route both throwError twins dispatch, and it sets the OPTIONS flag; the
 * nunjucks delegate and both async delegates read that flag only. The swig delegate now does too.
 *
 *  01 the declaration, comment-stripped: one, reading the options flag only, the statement the
 *     nunjucks delegate uses; it no longer reads the render data (with a control on the strip).
 *  02 behavioural: the extracted declaration evaluated with a data flag and with an options flag.
 *
 * The strip of the flag from the per-render copy is unchanged and stays pinned by
 * render-data-copy-b988.test.js §03.
 *
 * Seam: GINA_RENDER_SWIG_SRC=<absolute file> reads the swig delegate from that file. Red-first
 * against the pre-change bytes: 01's statement and data-read arms and 02's data-flag arms read
 * RED; 01's control and 02's options-flag controls stay GREEN.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW       = require('../fw');
var SWIG_SRC = fs.readFileSync(process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js'), 'utf8');
var NJ_SRC   = fs.readFileSync(path.join(FW, 'core/controller/controller.render-nunjucks.js'), 'utf8');

/** Drops full-line comments (`//`, `/*`, ` *`), so the `// was:` record of the old test cannot satisfy a pin. */
function stripComments(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}
/** The `var isRenderingCustomError = …;` statement of a comment-stripped source (its first `;` ends it). */
function declaration(src) {
    var st = stripComments(src);
    var at = st.indexOf('var isRenderingCustomError =');
    assert.ok(at > -1, 'the declaration is in the active code');
    assert.equal(st.indexOf('var isRenderingCustomError =', at + 1), -1, 'one declaration');
    return st.slice(at, st.indexOf(';', at) + 1);
}
function normalise(s) { return s.replace(/\s+/g, ' ').trim(); }

var SWIG_DECL = declaration(SWIG_SRC);

// ─── 01 — the declaration ────────────────────────────────────────────────────
describe('#B873 §01 — the swig delegate reads the options flag only', function () {
    it('CONTROL: the comment strip drops a `// was:` line and keeps code', function () {
        assert.equal(stripComments('var a = 1;\n    // was: var b = userData.isRenderingCustomError;\n    var c = 2;'), 'var a = 1;\n    var c = 2;');
    });
    it('the statement is the nunjucks delegate\'s own', function () {
        assert.equal(normalise(SWIG_DECL), normalise(declaration(NJ_SRC)));
        assert.equal(normalise(SWIG_DECL), 'var isRenderingCustomError = (localOptions.isRenderingCustomError === true);');
    });
    it('the statement does not read the render data', function () {
        assert.equal(SWIG_DECL.indexOf('userData'), -1);
    });
});

// ─── 02 — behavioural ────────────────────────────────────────────────────────
describe('#B873 §02 — a render-data flag no longer switches the render', function () {
    var decide = new Function('localOptions', 'userData', SWIG_DECL + '\nreturn isRenderingCustomError;');

    it('a data flag \'true\' with no options flag: a normal render', function () {
        assert.equal(decide({}, { isRenderingCustomError: 'true' }), false);
    });
    it('a data flag \'TRUE\' (any case, as a query string carries it): a normal render', function () {
        assert.equal(decide({}, { isRenderingCustomError: 'TRUE', x: '1' }), false);
    });
    it('a data flag true (a JSON body): a normal render', function () {
        assert.equal(decide({ isRenderingCustomError: false }, { isRenderingCustomError: true }), false);
    });
    it('CONTROL: the options flag set by renderCustomError: a custom-error render', function () {
        assert.equal(decide({ isRenderingCustomError: true }, {}), true);
    });
    it('CONTROL: the options flag wins whatever the data carries', function () {
        assert.equal(decide({ isRenderingCustomError: true }, { isRenderingCustomError: 'false' }), true);
    });
    it('CONTROL: only the boolean true counts on the options', function () {
        assert.equal(decide({ isRenderingCustomError: 'true' }, {}), false);
    });
    it('CONTROL: no data at all', function () {
        assert.equal(decide({}, null), false);
        assert.equal(decide({}, undefined), false);
    });
});
