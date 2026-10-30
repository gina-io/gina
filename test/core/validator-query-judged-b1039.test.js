'use strict';
/**
 * FormValidator — the pass a clean `query` verdict starts does not ask that query again (#B1039)
 *
 * A clean verdict starts a re-validation of the form. The `query` arm never removed its field from that
 * pass's input, and #B230 keeps a `_case_` driver in it whatever its rules, so the nested pass asked
 * again and its clean verdict started the same pass: the tab froze on a cached value, requests streamed
 * on an empty one. The nested pass now carries the fields whose verdict is in, and skips their `query`.
 *
 * The field stays in the pass on purpose. Taking it out re-seeds a driver's case value from
 * `$allFields[name].value`, a radio group's FIRST member whichever is checked (#B230), and the submit
 * control opens on an invalid form: measured, and arms 24–26 of the e2e spec keep it from coming back.
 *
 * Division of labor:
 *  - BEHAVIORAL: test/e2e/validator-query-only-b1039.spec.js, the real bundle in a real browser.
 *  - THIS file keeps the browserless `npm test` release gate able to detect a removed guard or a
 *    bundle that was not rebuilt.
 *
 * Comment-strip note: the pins read comment-stripped source, so the fix's own comments can neither
 * satisfy a positive pin nor trip the negative one.
 *
 * Run: node --test test/core/validator-query-judged-b1039.test.js
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW   = require('../fw');
var MAIN = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var MIN  = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var mainSrc, distSrc, minSrc, activeSrc;

/** Strip `//`-comment lines. */
function stripLineComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
}

/** The `if (needsGlobalReValidation)` block, up to the validate call it ends on. */
function nestedPassBlock(src) {
    var start = src.indexOf('if (needsGlobalReValidation) {');
    assert.ok(start > -1, '[instrument] the re-validation block vanished');
    var call = src.indexOf('validate($currentForm, allFields, $allFields, rules, onSilentQueryGlobalLiveValidation);', start);
    assert.ok(call > start, 'the pass must be started with its named callback');
    return src.substring(start, call);
}

before(function () {
    mainSrc   = fs.readFileSync(MAIN, 'utf8');
    distSrc   = fs.readFileSync(DIST, 'utf8');
    minSrc    = fs.readFileSync(MIN, 'utf8');
    activeSrc = stripLineComments(mainSrc);
});

describe('#B1039 — source pins', function () {

    it('01 - the query arm skips a field whose verdict is in, before it arms anything', function () {
        assert.match(activeSrc,
            /if \( \/\^query\$\/\.test\(rule\) \) \{\s*if \( cb && cb\.judgedQueries && cb\.judgedQueries\[field\] \) \{\s*continue;\s*\}\s*\$asyncField\s*= \$fields\[field\];/);
    });

    it('02 - each nested pass holds its own copy of the set, with the field that started it', function () {
        var block = nestedPassBlock(activeSrc);
        var copy  = block.indexOf('var judgedQueries = ( cb && cb.judgedQueries ) ? JSON.clone(cb.judgedQueries) : {};');
        var add   = block.indexOf('judgedQueries[field] = true;');
        assert.ok(copy > -1, 'a copy, or sibling chains of one form would share the set');
        assert.ok(add > copy, 'the field that started the pass joins the copy');
    });

    it('03 - the set rides the callback of the pass it is for', function () {
        var block = nestedPassBlock(activeSrc);
        assert.ok(block.indexOf('onSilentQueryGlobalLiveValidation.judgedQueries = judgedQueries;') > -1);
    });

    it('04 - the field stays in the pass: the block takes nothing out of its input', function () {
        var block = nestedPassBlock(activeSrc);
        assert.ok(!/delete\s+allFields/.test(block),
            'deleting it re-seeds a driver\'s case value from the first radio of its group');
        // the control: the needle reads this shape when it is there
        assert.ok(/delete\s+allFields/.test('delete allFields[field];'));
    });
});

describe('#B1039 — dist pins', function () {

    it('05 - gina.js (optimize:"none") carries the guard and the set', function () {
        assert.ok(distSrc.indexOf('cb && cb.judgedQueries && cb.judgedQueries[field]') > -1, 'the guard');
        assert.ok(distSrc.indexOf('onSilentQueryGlobalLiveValidation.judgedQueries = judgedQueries;') > -1, 'the set');
    });

    it('06 - gina.min.js carries the guard (the property name survives Closure)', function () {
        assert.match(minSrc, /\b(\w+)&&\1\.judgedQueries&&\1\.judgedQueries\[\w+\]/);
    });
});
