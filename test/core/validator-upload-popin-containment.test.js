/**
 * #B572 — a staged upload is placed by CONTAINMENT, never by "some popin is open".
 *
 * Source pins + one driven arm for the file-selection handler in
 * core/plugins/lib/validator/src/main.js. The behaviour itself is proven on the real bundle
 * by test/e2e/validator-upload-popin-containment.spec.js; this file owns what the e2e harness
 * cannot reach (it serves `envIsDev: 'false'`): the dev-mode notice, and the SHAPE of the
 * capture, which a behavioural arm cannot distinguish from a lucky one.
 *
 *  §01 extraction controls — the upload `change` handler and the notice helper each exist
 *      exactly once (a pin that cannot find its block is not a pin)
 *  §02 NO `isPopinContext()` call inside the upload block. Scoped to the BLOCK on purpose: the
 *      file legitimately keeps the definition (`var isPopinContext = function`) and the
 *      unrelated INSTANCE flag (`this.isPopinContext`, the popin-constructed validator) — both
 *      asserted PRESENT outside the block as the controls that the strip/scope did not
 *      vaporise the token
 *  §03 the capture: guarded on `getPopinContaining` being a function, reads `$el.form`, made
 *      ONCE (the five sites read `$ownerPopin`, none re-resolves)
 *  §04 the five sites: branch, createElement, previewContainer, the `uploadProperties` flag
 *      (kept for shape, value `!!$ownerPopin`), the append — each on `$ownerPopin`; and the
 *      notice is called from the handler with the real form and the input
 *  §05 the helper's shape: `envIsDev`-gated, owner short-circuit, only an OPEN popin is named
 *  §06 the helper DRIVEN in a lifted scope with EVERY free identifier supplied (envIsDev,
 *      gina, console): warns once naming the popin, the input and the form when dev + no
 *      owner + an open popin; silent with an owner; silent outside dev; silent with no popin;
 *      silent when the resolved popin is not open; never throws without a popin handler
 *
 * Red-first: GINA_VALIDATOR_SRC=<a `git show HEAD~:…` copy> ⇒ §01's helper control and
 * §02–§06 all RED on the pre-fix source.
 *
 * Usage: node --test test/core/validator-upload-popin-containment.test.js
 */
'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW = require('../fw');
var VAL_SRC = process.env.GINA_VALIDATOR_SRC || path.join(FW, 'core/plugins/lib/validator/src/main.js');
var valSrc = fs.readFileSync(VAL_SRC, 'utf8');

/** Comment-stripped view — a negative pin must never trip on the file's own JSDoc/comments. */
function active(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

/** Started-flag brace walk from a line-start declaration; exactly-once + balance controls. */
function extract(src, declRe, label) {
    var re = new RegExp(declRe, 'mg');
    var m = re.exec(src);
    assert.ok(m, label + ': declaration present (extraction control)');
    assert.equal(re.exec(src), null, label + ': declared exactly once');
    var i = m.index, depth = 0, started = false;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    assert.equal(depth, 0, label + ': balanced braces');
    return src.slice(m.index, i) + ';';
}

function count(hay, needle) { return hay.split(needle).length - 1; }

var srcBlock  = extract(valSrc, "^[ \\t]*addListener\\(gina, \\$inputs\\[f\\], 'change', function\\(event\\) \\{", 'upload change handler');
var actBlock  = active(srcBlock);
var actFile   = active(valSrc);
var actOutside = actFile.replace(actBlock, '');

describe('#B572 §01 extraction controls', function () {
    it('01.1 the upload change handler is the block that builds the virtual form (not some other change listener)', function () {
        assert.ok(actBlock.indexOf("'gina-upload-'") > -1, 'the block mints the gina-upload-* id');
        assert.ok(actBlock.indexOf('uploadProperties') > -1, 'the block writes uploadProperties');
    });
    it('01.2 the notice helper exists exactly once (RED pre-fix)', function () {
        var h = extract(valSrc, '^[ \\t]*var warnIfOldRulePlacedUpload = function\\(', 'warnIfOldRulePlacedUpload');
        assert.ok(h.length > 200, 'a real body, not a stub');
    });
});

describe('#B572 §02 no "some popin is open" gate inside the upload block', function () {
    it('02.1 zero isPopinContext() calls in the block (RED pre-fix: five)', function () {
        assert.equal(count(actBlock, 'isPopinContext()'), 0);
    });
    it('02.2 CONTROL — the token survives OUTSIDE the block: the definition and the instance flag are untouched', function () {
        assert.equal(count(actOutside, 'var isPopinContext = function'), 1, 'the gate definition stays (other paths may still use it)');
        assert.ok(count(actOutside, 'this.isPopinContext') >= 1, 'the popin-constructed validator instance flag is a different thing and stays');
    });
    it('02.3 CONTROL — no $activePopin survives in the block (the renamed local would be a ReferenceError)', function () {
        assert.equal(count(actBlock, '$activePopin'), 0);
    });
});

describe('#B572 §03 the capture', function () {
    it('03.1 guarded exactly as the submit path: getPopinContaining must be a function (RED pre-fix)', function () {
        assert.equal(count(actBlock, "typeof(gina.popin.getPopinContaining) == 'function'"), 1);
    });
    it('03.2 resolves from the REAL form the input belongs to (RED pre-fix)', function () {
        assert.equal(count(actBlock, 'gina.popin.getPopinContaining($el.form || $el)'), 1);
    });
    it('03.3 captured ONCE — a single declaration, read by the sites (RED pre-fix)', function () {
        assert.equal(count(actBlock, 'var $ownerPopin'), 1);
        assert.ok(count(actBlock, '$ownerPopin') >= 8, 'read at every site: ' + count(actBlock, '$ownerPopin'));
        assert.equal(count(actBlock, 'getPopinContaining('), 1, 'never re-resolved');
    });
});

describe('#B572 §04 the sites read the captured owner', function () {
    it('04.1 the branch (RED pre-fix)', function () {
        assert.equal(count(actBlock, 'if ( $ownerPopin ) {'), 1);
        assert.equal(count(actBlock, '$uploadForm = $ownerPopin.$target.getElementById(uploadFormId)'), 1);
    });
    it('04.2 createElement (RED pre-fix)', function () {
        assert.equal(count(actBlock, "? $ownerPopin.$target.createElement('form')"), 1);
    });
    it('04.3 previewContainer (RED pre-fix)', function () {
        assert.equal(count(actBlock, '? $ownerPopin.$target.getElementById(previewContainer)'), 1);
    });
    it('04.4 the uploadProperties flag keeps its key, value from the capture (RED pre-fix)', function () {
        assert.equal(count(actBlock, 'isPopinContext      : !!$ownerPopin'), 1);
    });
    it('04.5 the append (RED pre-fix)', function () {
        assert.equal(count(actBlock, 'if ($ownerPopin) {'), 1);
        assert.equal(count(actBlock, 'document.getElementById($ownerPopin.id).appendChild($uploadForm)'), 1);
    });
    it('04.6 the notice is called from the handler with the real form and the input (RED pre-fix)', function () {
        assert.equal(count(actBlock, 'warnIfOldRulePlacedUpload($ownerPopin, $el.form, $el)'), 1);
    });
});

describe('#B572 §05 the helper\'s shape', function () {
    var h = null;
    try { h = active(extract(valSrc, '^[ \\t]*var warnIfOldRulePlacedUpload = function\\(', 'helper')); } catch (e) { h = ''; }
    it('05.1 dev-gated, owner short-circuit (RED pre-fix)', function () {
        assert.ok(h.indexOf('!envIsDev || $owner') > -1, 'guard: !envIsDev || $owner');
    });
    it('05.2 names only an OPEN popin — the retired gate required isOpen (RED pre-fix)', function () {
        assert.ok(h.indexOf('!$old || !$old.isOpen') > -1);
        assert.ok(h.indexOf('$old.name') > -1);
    });
    it('05.3 resolves what the retired gate resolved: getActivePopin (RED pre-fix)', function () {
        assert.ok(h.indexOf('gina.popin.getActivePopin()') > -1);
    });
});

describe('#B572 §06 the helper DRIVEN (lifted scope — every free identifier supplied)', function () {
    var src = null;
    try { src = extract(valSrc, '^[ \\t]*var warnIfOldRulePlacedUpload = function\\(', 'helper'); } catch (e) { src = null; }
    function run(dev, owner, resolved, opts) {
        opts = opts || {};
        var warns = [];
        var gina = opts.noPopin ? {} : { popin: { getActivePopin: function () { return resolved; } } };
        var console_ = { warn: function (m) { warns.push(String(m)); } };
        // the helper closes over envIsDev, gina and console only — all three are supplied here,
        // so the lifted scope models the module scope faithfully for this function
        var fn = new Function('envIsDev', 'gina', 'console', src + '\nreturn warnIfOldRulePlacedUpload;')(dev, gina, console_);
        fn(owner, { id: 'pageform' }, { id: 'docA' });
        return warns;
    }
    var openPopin = { name: 'sidebar', isOpen: true };

    it('06.1 POSITIVE — dev, page form, an open popin: exactly one notice naming the popin, the input and the form (RED pre-fix)', function () {
        assert.ok(src, 'helper present');
        var w = run(true, null, openPopin);
        assert.equal(w.length, 1);
        assert.ok(/\[FormValidator\]\[popin\]/.test(w[0]), w[0]);
        assert.ok(w[0].indexOf('`sidebar`') > -1, 'names the popin');
        assert.ok(w[0].indexOf('`#docA`') > -1, 'names the input');
        assert.ok(w[0].indexOf('`#pageform`') > -1, 'names the form');
        assert.ok(w[0].indexOf('placed with its own form') > -1);
        assert.ok(w[0].indexOf('never have reached the form') > -1, 'says what the old rule cost');
    });
    it('06.2 silent when the form IS inside a popin (the owner short-circuit) — green on both trees is NOT this arm\'s job; it reds pre-fix on the missing helper', function () {
        assert.ok(src, 'helper present');
        assert.equal(run(true, { name: 'own', isOpen: true }, openPopin).length, 0);
    });
    it('06.3 silent outside dev mode', function () {
        assert.ok(src, 'helper present');
        assert.equal(run(false, null, openPopin).length, 0);
    });
    it('06.4 silent when nothing resolves (no popin open)', function () {
        assert.ok(src, 'helper present');
        assert.equal(run(true, null, null).length, 0);
    });
    it('06.5 silent when the resolved popin is NOT open — the retired gate would not have placed there either', function () {
        assert.ok(src, 'helper present');
        assert.equal(run(true, null, { name: 'closed', isOpen: false }).length, 0);
    });
    it('06.6 never throws without a popin handler', function () {
        assert.ok(src, 'helper present');
        assert.equal(run(true, null, openPopin, { noPopin: true }).length, 0);
    });
});
