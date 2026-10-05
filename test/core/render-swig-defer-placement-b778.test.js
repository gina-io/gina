'use strict';
/**
 * #B778 — since #B772 a page's own `javascriptsDeferEnabled: false` reaches its
 * template (lib/merge used to turn it into `true`). render-swig placed the page's
 * scripts from `template || _common || false`, so under a `_common` that is `true`
 * the scripts stayed in <head> while getNodeRes() (controller.js), which writes the
 * `defer` attribute from the template value alone, wrote them without `defer`:
 * render-blocking scripts, run before the body is parsed. The placement now reads
 * the template value the way getNodeRes() and the other three delegates do
 * (`!!(tpl && tpl.javascriptsDeferEnabled)`), so the scripts are in <head> with
 * `defer`, or before </body> without it, and never in <head> without it.
 *
 * §01 evaluates render-swig's own placement expression (the right-hand side of its
 * one `isDeferModeEnabled =` assignment, compiled with `new Function`) for every
 * template / `_common` pairing. §02 holds it to getNodeRes()' `defer` rule, read
 * from controller.js the same way. The live reading (a real bundle: where gina's
 * <script> lands, and whether it carries `defer`) is the #B768 scene.
 *
 * Seams — point a section at a pre-change copy for a red-first run:
 * GINA_RENDER_SWIG_SRC, GINA_CONTROLLER_SRC.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW = require('../fw');

var RENDER_SWIG_SRC = process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js');
var CONTROLLER_SRC  = process.env.GINA_CONTROLLER_SRC  || path.join(FW, 'core/controller/controller.js');

/** Remove block comments and whole-line `//` comments. @inner */
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/mg, '');
}

/**
 * The right-hand side of the ONE line-initial `<name> = …;` assignment in `src`
 * (comments stripped), up to its `;`.
 * @inner
 */
function rhsOf(src, name) {
    var code = stripComments(src);
    var re   = new RegExp('^[ \\t]*' + name + '[ \\t]*=[ \\t]*(?!null\\b)', 'mg');
    var hits = [], m;
    while ( (m = re.exec(code)) !== null ) { hits.push(m.index + m[0].length); }
    assert.equal(hits.length, 1, 'one line-initial `' + name + ' =` assignment');
    var end = code.indexOf(';', hits[0]);
    assert.ok(end > hits[0], 'the assignment ends with `;`');
    return code.slice(hits[0], end);
}

var placement = null, deferAttr = null;

before(function () {
    placement = new Function('localOptions', 'return (' + rhsOf(fs.readFileSync(RENDER_SWIG_SRC, 'utf8'), 'isDeferModeEnabled') + ');');
    var ctrl = stripComments(fs.readFileSync(CONTROLLER_SRC, 'utf8'));
    var at   = ctrl.indexOf('var deferMode = ');
    assert.ok(at > -1, 'getNodeRes() builds `deferMode`');
    assert.equal(ctrl.indexOf('var deferMode = ', at + 1), -1, 'one `var deferMode =`');
    deferAttr = new Function('local', 'return (' + ctrl.slice(at + 'var deferMode = '.length, ctrl.indexOf(';', at)) + ');');
});

/** render-swig's localOptions for a template value and a `_common` value. @inner */
function opts(tpl, common) {
    var t = {}; if ( typeof(tpl) != 'undefined' ) { t.javascriptsDeferEnabled = tpl; }
    return { template: t, conf: { content: { templates: { _common: { javascriptsDeferEnabled: common } } } } };
}

var PAIRS = [];
[true, false, undefined].forEach(function (tpl) { [true, false].forEach(function (common) { PAIRS.push([tpl, common]); }); });

describe('01 - #B778: render-swig places the scripts from the template\'s own javascriptsDeferEnabled', function () {

    it('01.1 a page `false` under a `_common` `true`: before </body> (it went in <head>)', function () {
        assert.equal(!!placement(opts(false, true)), false);
    });

    it('01.2 every template / _common pairing follows the template value alone', function () {
        PAIRS.forEach(function (p) {
            assert.equal(!!placement(opts(p[0], p[1])), !!p[0], 'template ' + p[0] + ', _common ' + p[1]);
        });
    });

    it('01.3 controls: a page `true` goes in <head> whatever `_common` says', function () {
        assert.equal(!!placement(opts(true, false)), true);
        assert.equal(!!placement(opts(true, true)), true);
    });
});

describe('02 - #B778: placement and getNodeRes()\' `defer` attribute always agree', function () {

    it('02.1 in <head> exactly when the tag carries `defer`, for every pairing', function () {
        PAIRS.forEach(function (p) {
            var o = opts(p[0], p[1]);
            var hasDefer = deferAttr({ options: { template: o.template } }) === ' defer';
            assert.equal(!!placement(o), hasDefer, 'template ' + p[0] + ', _common ' + p[1]);
        });
    });
});
