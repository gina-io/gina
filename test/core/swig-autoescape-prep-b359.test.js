/**
 * #B359 prep — the 0.7.0 half of the swig `autoescape` default flip (the flip itself is 0.8.0).
 *
 * What 0.7.0 ships, pinned here:
 *   01  `initSwigEngine` warns ONCE per bundle when the bundle renders swig and
 *       `settings.swig.autoescape` is unset, naming 0.8.0; setting it either way silences it.
 *       The warning sits after the strictly-boolean type guard and before the engine options.
 *   02  the engine gate (`rendersSwig`, lifted from the real source — it reads only its
 *       argument): the settings-level engine, else any templates.json section with a `.swig`
 *       ext. A nunjucks-only bundle still reaches initSwigEngine (the error template is swig)
 *       and is NOT warned.
 *   03  new bundles are scaffolded with `"swig": { "autoescape": true }`, and the framework
 *       defaults merged into EVERY bundle (`core/template/conf/settings.json`) carry no `swig`
 *       key — the invariant that keeps "unset" detectable (a default there would silence the
 *       warning for every bundle).
 *   04  the schema default stays `false` in 0.7.0 and its description names the 0.8.0 flip.
 *
 * The booted arms (the warning printed once for an unset key and never for a set one; a
 * scaffolded bundle's settings.json) are in test/integration/container-boot-swig-autoescape.test.js.
 *
 * Seam for red-first: GINA_SERVER_SRC=<file>.
 *
 * Run standalone:
 *   node --test test/core/swig-autoescape-prep-b359.test.js
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW   = require('../fw');
var ROOT = path.resolve(__dirname, '../..');

var SERVER_SRC = fs.readFileSync(process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js'), 'utf8');

function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/mg, '');
}
/**
 * JSONC → object: drops `//` and `/* *\/` comments outside strings, then trailing commas.
 * The framework defaults file carries end-of-line comments, not only whole-line ones.
 */
function readJsonc(file) {
    var s = fs.readFileSync(file, 'utf8'), out = '', i = 0, inStr = false;
    while (i < s.length) {
        var c = s[i];
        if (inStr) {
            out += c;
            if (c === '\\') { out += s[i + 1]; i += 2; continue; }
            if (c === '"') { inStr = false; }
            i++; continue;
        }
        if (c === '"') { inStr = true; out += c; i++; continue; }
        if (s.startsWith('//', i)) { var nl = s.indexOf('\n', i); i = (nl < 0) ? s.length : nl; continue; }
        if (s.startsWith('/*', i)) { var end = s.indexOf('*/', i + 2); i = (end < 0) ? s.length : end + 2; continue; }
        out += c; i++;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

describe('#B359 prep — swig autoescape boot warning, engine gate, scaffold, schema', function () {

    describe('01 - the boot warning in initSwigEngine', function () {
        var CODE = stripComments(SERVER_SRC);
        var start = CODE.indexOf('var initSwigEngine = function(conf) {');
        var body  = CODE.slice(start, CODE.indexOf('var swigOptions = {', start));

        it('initSwigEngine is found, and the warning block sits before the engine options', function () {
            assert.ok(start > -1, 'initSwigEngine present');
            assert.ok(body.indexOf("settings.swig.autoescape is not set for [ '+ self.appName +' ]") > -1, 'the warning names the bundle');
        });

        it('it is gated on: the key unset, not yet warned, and the bundle rendering swig', function () {
            assert.ok(body.indexOf("if ( typeof(_swigSettings.autoescape) == 'undefined' && !_swigAutoescapeUnsetWarned && rendersSwig(conf) ) {") > -1);
            assert.ok(body.indexOf('_swigAutoescapeUnsetWarned = true;') > -1, 'the once-per-bundle flag is set');
            assert.ok(CODE.indexOf('var _swigAutoescapeUnsetWarned = false;') > -1, 'the flag starts false');
        });

        it('it runs after the strictly-boolean type guard, so a mis-typed value still refuses the boot', function () {
            var guard = body.indexOf("throw new Error('[ SWIG ] settings.swig.autoescape must be a boolean");
            var warn  = body.indexOf('_swigAutoescapeUnsetWarned = true;');
            assert.ok(guard > -1 && warn > guard, 'guard first, then the warning');
        });

        it('the message names the 0.8.0 flip, both explicit values, | safe, and the settings reference', function () {
            ['The default becomes true in 0.8.0', 'true escapes output', 'false keeps output unescaped',
                '{{ gina.csrfInput | safe }}', 'https://gina.io/docs/reference/settings#swig'].forEach(function (needle) {
                assert.ok(body.indexOf(needle) > -1, needle);
            });
        });

        it('the governing expression is unchanged: absent or false still renders unescaped in 0.7.0', function () {
            assert.ok(CODE.indexOf('autoescape: (_swigSettings.autoescape === true),') > -1);
        });
    });

    describe('02 - rendersSwig (lifted from the real source)', function () {
        var m = SERVER_SRC.match(/var rendersSwig = (function\(conf\) \{[\s\S]*?\n    \});/);
        var rendersSwig = m ? new Function('return ' + m[1])() : null;

        it('is found and self-contained', function () {
            assert.ok(rendersSwig, 'rendersSwig declared as a function expression');
        });

        var cases = [
            ['no conf', undefined, true],
            ['no render block (the default engine is swig)', { content: { settings: {} } }, true],
            ['render.engine swig', { content: { settings: { render: { engine: 'swig' } } } }, true],
            ['render.engine nunjucks, no sections', { content: { settings: { render: { engine: 'nunjucks' } }, templates: { _common: {} } } }, false],
            ['nunjucks with a .njk section', { content: { settings: { render: { engine: 'nunjucks' } }, templates: { home: { ext: '.njk' } } } }, false],
            ['nunjucks with a .swig section', { content: { settings: { render: { engine: 'nunjucks' } }, templates: { home: { ext: '.swig' } } } }, true],
            ['nunjucks with a `swig` ext (no dot)', { content: { settings: { render: { engine: 'nunjucks' } }, templates: { home: { ext: 'swig' } } } }, true],
            ['nunjucks with a `.SWIG` ext', { content: { settings: { render: { engine: 'nunjucks' } }, templates: { home: { ext: '.SWIG' } } } }, true],
            ['nunjucks with a `.swigx` ext', { content: { settings: { render: { engine: 'nunjucks' } }, templates: { home: { ext: '.swigx' } } } }, false]
        ];
        cases.forEach(function (c) {
            it(c[0] + ' → ' + c[2], function () {
                assert.equal(rendersSwig(c[1]), c[2]);
            });
        });
    });

    describe('03 - the scaffold and the framework defaults', function () {
        it('the bundle scaffold sets swig.autoescape: true', function () {
            var s = readJsonc(path.join(FW, 'core/template/boilerplate/bundle/config/settings.json'));
            assert.deepEqual(s.swig, { autoescape: true });
            assert.ok(s.region, 'the rest of the scaffold is intact');
        });

        it('the defaults merged into every bundle carry NO swig key (else "unset" could never be seen)', function () {
            var d = readJsonc(path.join(FW, 'core/template/conf/settings.json'));
            assert.equal(Object.prototype.hasOwnProperty.call(d, 'swig'), false);
            // control: the file is the defaults file and it parsed
            assert.ok(Object.keys(d).length > 0);
        });
    });

    describe('04 - schema/settings.json', function () {
        var SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema/settings.json'), 'utf8'));
        it('autoescape stays boolean with default false, and the description names the 0.8.0 flip', function () {
            var ae = SCHEMA.properties.swig.properties.autoescape;
            assert.equal(ae.type, 'boolean');
            assert.equal(ae.default, false);
            assert.ok(/until 0\.8\.0/.test(ae.description), ae.description);
            assert.ok(/boot warning/.test(ae.description), ae.description);
        });
    });
});
