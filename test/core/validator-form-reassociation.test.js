'use strict';
/**
 * FormValidator binding for HTML5 form-reassociated controls (form="X" attribute)
 *
 * Per the HTML spec, an input/button can carry a `form="..."` attribute that binds
 * it to a form element it is NOT a DOM descendant of. The form's HTMLFormControlsCollection
 * (form.elements / form.length / form[i]) reflects this owner relationship; getElementsByTagName
 * does not. This test covers the validator plugin's owner-aware control collection
 * (getOwnedElements helper), per-control listener attachment for reassociated controls,
 * and unbindForm cleanup symmetry.
 *
 * Strategy:
 *  - jsdom-backed DOM exercises getOwnedElements directly against parent + reassociated
 *    layouts (behavioural).
 *  - Source-inspection pins the structural changes in main.js (helper exists, bindForm
 *    uses it for the four field-collection sites + button collection, reassociatedListeners
 *    side-table is initialised + drained, proxy handlers are extracted as named
 *    expressions, per-control reassociated loop attaches them on out-of-tree controls).
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW   = require('../fw');
var MAIN = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var FV   = path.join(FW, 'core/plugins/lib/validator/src/form-validator.js');

var mainSrc;
var fvSrc;

before(function () {
    mainSrc = fs.readFileSync(MAIN, 'utf8');
    fvSrc   = fs.readFileSync(FV, 'utf8');
});


// --- Test-local copy of getOwnedElements ---
// MUST mirror the inline definition in main.js. The source-inspection block
// at the end of this file pins the source-side shape so this stays honest.
function getOwnedElements($form, tag) {
    // #B333 realign (approved 2026-08-11): dedup is by NODE IDENTITY now — the
    // id-keyed `seen` table let an ID-LESS control enter twice (once from
    // $form.elements, once from the in-tree sweep). Mirrors main.js exactly.
    var arr = [], tagUpper = tag.toUpperCase();
    for (var i = 0, len = $form.elements.length; i < len; i++) {
        var $el = $form.elements[i];
        if ($el.tagName === tagUpper) {
            arr.push($el);
        }
    }
    var inTree = $form.getElementsByTagName(tag);
    for (var j = 0, jLen = inTree.length; j < jLen; j++) {
        var $el2 = inTree[j];
        if ($el2.form === $form && arr.indexOf($el2) === -1) {
            arr.push($el2);
        }
    }
    return arr;
}


// --- DOM fixture ---
function setupDom() {
    var dom = new JSDOM(`<!DOCTYPE html><html><body>
        <form id="parent">
            <input id="parentField" name="parentField" type="text">
            <input id="childField" name="childField" form="child" type="text">
            <input id="parentImage" name="parentImage" type="image" src="x.png">
            <textarea id="parentNote" name="parentNote"></textarea>
            <textarea id="childNote" name="childNote" form="child"></textarea>
            <select id="parentSel" name="parentSel"><option value="a">a</option></select>
            <select id="childSel" name="childSel" form="child"><option value="b">b</option></select>
            <button id="parentSubmit" type="submit">Submit Parent</button>
            <button id="childSubmit" form="child" type="submit">Submit Child</button>
        </form>
        <form id="child"></form>
        <form id="standalone">
            <input id="soloField" name="soloField" type="text">
            <input id="soloImage" name="soloImage" type="image" src="x.png">
            <button id="soloSubmit" type="submit">Submit</button>
        </form>
    </body></html>`);
    return {
        window         : dom.window,
        document       : dom.window.document,
        parentForm     : dom.window.document.getElementById('parent'),
        childForm      : dom.window.document.getElementById('child'),
        standaloneForm : dom.window.document.getElementById('standalone')
    };
}


// 01 - parent-form filter excludes reassociated descendants

describe('01 - parent form: getOwnedElements excludes reassociated descendants', function () {
    it('returns parentField but NOT childField', function () {
        var ctx    = setupDom();
        var inputs = getOwnedElements(ctx.parentForm, 'input');
        var ids    = inputs.map(function (el) { return el.id; });
        assert.ok(ids.indexOf('parentField') >= 0,
            "parentField should be in parent form's inputs");
        assert.equal(ids.indexOf('childField'), -1,
            'childField (form="child") should NOT be in parent form\'s inputs');
    });

    it('returns parentSubmit but NOT childSubmit', function () {
        var ctx     = setupDom();
        var buttons = getOwnedElements(ctx.parentForm, 'button');
        var ids     = buttons.map(function (el) { return el.id; });
        assert.ok(ids.indexOf('parentSubmit') >= 0);
        assert.equal(ids.indexOf('childSubmit'), -1,
            'childSubmit (form="child") should NOT be in parent form\'s buttons');
    });

    it('returns parentNote but NOT childNote', function () {
        var ctx       = setupDom();
        var textareas = getOwnedElements(ctx.parentForm, 'textarea');
        var ids       = textareas.map(function (el) { return el.id; });
        assert.ok(ids.indexOf('parentNote') >= 0);
        assert.equal(ids.indexOf('childNote'), -1);
    });

    it('returns parentSel but NOT childSel', function () {
        var ctx     = setupDom();
        var selects = getOwnedElements(ctx.parentForm, 'select');
        var ids     = selects.map(function (el) { return el.id; });
        assert.ok(ids.indexOf('parentSel') >= 0);
        assert.equal(ids.indexOf('childSel'), -1);
    });

    it('picks up type=image input via secondary sweep', function () {
        var ctx    = setupDom();
        var inputs = getOwnedElements(ctx.parentForm, 'input');
        var ids    = inputs.map(function (el) { return el.id; });
        assert.ok(ids.indexOf('parentImage') >= 0,
            'type=image input owned by parent should be picked up by the secondary sweep');
    });
});


// 02 - child form picks up reassociated controls

describe('02 - child form: getOwnedElements picks up reassociated controls', function () {
    it('returns childField (input form="child")', function () {
        var ctx    = setupDom();
        var inputs = getOwnedElements(ctx.childForm, 'input');
        var ids    = inputs.map(function (el) { return el.id; });
        assert.ok(ids.indexOf('childField') >= 0,
            'childField should be in child form\'s inputs (HTMLFormControlsCollection owner-aware)');
        assert.equal(ids.indexOf('parentField'), -1,
            'parentField should not appear in child form\'s inputs');
    });

    it('returns childSubmit (button form="child")', function () {
        var ctx     = setupDom();
        var buttons = getOwnedElements(ctx.childForm, 'button');
        var ids     = buttons.map(function (el) { return el.id; });
        assert.ok(ids.indexOf('childSubmit') >= 0);
    });

    it('returns childNote (textarea form="child") and childSel (select form="child")', function () {
        var ctx       = setupDom();
        var textareas = getOwnedElements(ctx.childForm, 'textarea');
        var selects   = getOwnedElements(ctx.childForm, 'select');
        assert.ok(textareas.map(function (el) { return el.id; }).indexOf('childNote') >= 0);
        assert.ok(selects.map(function (el) { return el.id; }).indexOf('childSel') >= 0);
    });

    it('child.elements (HTMLFormControlsCollection) reflects all reassociated owned controls', function () {
        var ctx        = setupDom();
        var elementIds = [];
        for (var i = 0; i < ctx.childForm.elements.length; i++) {
            elementIds.push(ctx.childForm.elements[i].id);
        }
        assert.ok(elementIds.indexOf('childField') >= 0);
        assert.ok(elementIds.indexOf('childNote') >= 0);
        assert.ok(elementIds.indexOf('childSel') >= 0);
        assert.ok(elementIds.indexOf('childSubmit') >= 0);
    });

    it('child form\'s subtree contains zero reassociated controls (proves the form-element tree is empty)', function () {
        var ctx    = setupDom();
        var inputs = ctx.childForm.getElementsByTagName('input');
        assert.equal(inputs.length, 0,
            'child form has no DOM-tree inputs — all its controls are reassociated');
    });
});


// 03 - regression guard for in-tree-only forms

describe('03 - standalone form: regression guard for in-tree-only binding', function () {
    it('binds soloField + soloImage (the latter via secondary sweep)', function () {
        var ctx    = setupDom();
        var inputs = getOwnedElements(ctx.standaloneForm, 'input');
        var ids    = inputs.map(function (el) { return el.id; });
        assert.ok(ids.indexOf('soloField') >= 0);
        assert.ok(ids.indexOf('soloImage') >= 0);
        assert.equal(inputs.length, 2);
    });

    it('returns soloSubmit', function () {
        var ctx     = setupDom();
        var buttons = getOwnedElements(ctx.standaloneForm, 'button');
        assert.equal(buttons.length, 1);
        assert.equal(buttons[0].id, 'soloSubmit');
    });

    it('does not include controls owned by other forms', function () {
        var ctx    = setupDom();
        var inputs = getOwnedElements(ctx.standaloneForm, 'input');
        var ids    = inputs.map(function (el) { return el.id; });
        assert.equal(ids.indexOf('parentField'), -1);
        assert.equal(ids.indexOf('childField'), -1);
    });
});


// 04 - source inspection: structural pins on main.js

describe('04 - source inspection: structural pins on main.js', function () {
    it('getOwnedElements helper exists in bindForm', function () {
        assert.ok(/var\s+getOwnedElements\s*=\s*function\s*\(\$form,\s*tag\)/i.test(mainSrc),
            'getOwnedElements function definition should be present');
        assert.ok(/\$form\.elements\.length/i.test(mainSrc),
            'getOwnedElements should iterate $form.elements (HTMLFormControlsCollection)');
        assert.ok(/\$el\.form\s*===\s*\$form/.test(mainSrc),
            'secondary sweep should filter by $el.form === $form (parent-form-contamination guard)');
    });

    it('the four field-collection sites use getOwnedElements', function () {
        assert.ok(/\$inputs\s*=\s*getOwnedElements\(\$target,\s*['"]input['"]\)/.test(mainSrc),
            '$inputs should source via getOwnedElements');
        assert.ok(/\$textareas\s*=\s*getOwnedElements\(\$target,\s*['"]textarea['"]\)/.test(mainSrc),
            '$textareas should source via getOwnedElements');
        assert.ok(/\$select\s*=\s*getOwnedElements\(\$target,\s*['"]select['"]\)/.test(mainSrc),
            '$select should source via getOwnedElements');
        assert.ok(/\$buttonsTMP\s*=\s*getOwnedElements\(\$target,\s*['"]button['"]\)/.test(mainSrc),
            '$buttonsTMP should source via getOwnedElements');
    });

    it('bindForm initialises $form.reassociatedListeners side-table', function () {
        assert.ok(/Array\.isArray\(\$form\.reassociatedListeners\)/.test(mainSrc),
            '$form.reassociatedListeners initialiser should guard with Array.isArray()');
        assert.ok(/\$form\.reassociatedListeners\s*=\s*\[\]/.test(mainSrc),
            '$form.reassociatedListeners should be initialised as []');
    });

    it('proxy handlers are extracted as named expressions (reusable form-level + per-control)', function () {
        assert.ok(/var\s+resetProxyHandler\s*=\s*function/.test(mainSrc));
        assert.ok(/var\s+keydownProxyHandler\s*=\s*function/.test(mainSrc));
        assert.ok(/var\s+keyupProxyHandler\s*=\s*function/.test(mainSrc));
        assert.ok(/var\s+focusinProxyHandler\s*=\s*function/.test(mainSrc));
        assert.ok(/var\s+focusoutProxyHandler\s*=\s*function/.test(mainSrc));
        assert.ok(/var\s+changeProxyHandler\s*=\s*function/.test(mainSrc));
        assert.ok(/var\s+clickProxyHandler\s*=\s*function/.test(mainSrc));
    });

    it('form-level proxies dispatch via the named handlers (not inline closures)', function () {
        assert.ok(/addListener\(gina,\s*\$target,\s*['"]reset['"],\s*resetProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$target,\s*['"]keydown['"],\s*keydownProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$target,\s*['"]keyup['"],\s*keyupProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$target,\s*['"]focusin['"],\s*focusinProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$target,\s*['"]focusout['"],\s*focusoutProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$target,\s*['"]change['"],\s*changeProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$target,\s*['"]click['"],\s*clickProxyHandler\)/.test(mainSrc));
    });

    it('per-control reassociated loop attaches the 6 handlers on each out-of-tree control', function () {
        assert.ok(/!\$target\.contains\(\$rEl\)/.test(mainSrc),
            'reassociated loop should branch on !$target.contains($rEl)');
        assert.ok(/addListener\(gina,\s*\$rEl,\s*['"]click['"],\s*clickProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$rEl,\s*['"]change['"],\s*changeProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$rEl,\s*['"]keydown['"],\s*keydownProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$rEl,\s*['"]keyup['"],\s*keyupProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$rEl,\s*['"]focusin['"],\s*focusinProxyHandler\)/.test(mainSrc));
        assert.ok(/addListener\(gina,\s*\$rEl,\s*['"]focusout['"],\s*focusoutProxyHandler\)/.test(mainSrc));
    });

    it('per-control loop tracks listeners on $form.reassociatedListeners', function () {
        assert.ok(/\$form\.reassociatedListeners\.push\(/.test(mainSrc),
            'per-control loop should push {el, evt, fn} entries onto $form.reassociatedListeners');
    });

    it('unbindForm drains $form.reassociatedListeners', function () {
        assert.ok(/Array\.isArray\(\$form\.reassociatedListeners\)/.test(mainSrc),
            'unbindForm should check Array.isArray($form.reassociatedListeners)');
        assert.ok(/entry\.el\.removeEventListener\(entry\.evt,\s*entry\.fn/.test(mainSrc),
            'unbindForm should call entry.el.removeEventListener(entry.evt, entry.fn)');
    });

    it('reset and submit are NOT in the per-control reassociated event list', function () {
        // Reset and submit fire on the form directly (not on controls); the form-level
        // listeners on $target capture them for both in-tree and reassociated controls.
        // Confirm the per-control loop's event list excludes them by counting addListener
        // calls within the reassociated branch.
        var reassociatedBlock = mainSrc.match(/!\\$target\.contains\(\\$rEl\)\)\s*\{[\s\S]*?\}\s*\}/);
        // Use a slightly looser matcher (the block contents):
        var reassociatedRange = mainSrc.indexOf('!$target.contains($rEl)');
        assert.ok(reassociatedRange > 0, 'reassociated branch should be present');
        var blockEnd = mainSrc.indexOf('}', reassociatedRange + 200);
        var blockSrc = mainSrc.substring(reassociatedRange, blockEnd + 1);
        assert.equal(/addListener\(gina,\s*\$rEl,\s*['"]reset['"]/.test(blockSrc), false,
            'reset should NOT be attached per-control (form-level handles it)');
        assert.equal(/addListener\(gina,\s*\$rEl,\s*['"]submit['"]/.test(blockSrc), false,
            'submit should NOT be attached per-control (form-level handles it)');
    });
});


// ============================================================================
// updateRadio fixes: form-owner-scoped mutual exclusion + IDL/attribute
// reconciliation at parse time.
//
// Spec: an `<input type="radio" form="X">` is owned by form X regardless of
// where it sits in the DOM tree, and mutual exclusion is defined as same
// `name` + same form-owner. Two reassociated radios that share a `name` but
// belong to DIFFERENT form-owners are in DIFFERENT groups and may both be
// checked simultaneously.
//
// Two production bugs the fixes address:
//   (1) Chromium-based browsers desync the IDL `.checked` from the `checked`
//       HTML attribute when multiple form-reassociated radios share a `name`
//       and are DOM descendants of a common ancestor `<form>`. updateRadio's
//       init path now reconciles the two when they disagree.
//   (2) updateRadio built its mutual-exclusion peer set from
//       `document.getElementsByName($el.name)`, which spans the whole
//       document and ignores form-owner. The peer set is now filtered to
//       same-form-owner radios only.
// ============================================================================

// --- Test-local copies of the two updateRadio fix logic blocks ---
// MUST mirror the inline blocks in main.js. The source-inspection block in
// section 06 pins the source-side shape so these stay honest.

function reconcileCheckedFromAttribute($el, isInit) {
    if ( isInit && !$el.checked && $el.hasAttribute('checked') ) {
        $el.checked = true;
    }
}

function getRadioGroup($el, document) {
    var raw = document.getElementsByName($el.name);
    return Array.prototype.filter.call(raw, function (_r) {
        return _r.form === $el.form;
    });
}

// Mirrors the unchecking loop inside updateRadio when $el is checked.
function applyMutualExclusion(group, $el) {
    var checked = $el.checked;
    for (var r = 0, rLen = group.length; r < rLen; ++r) {
        if (group[r].id !== $el.id && checked) {
            group[r].checked = false;
            group[r].removeAttribute('checked');
        }
    }
}


// --- DOM fixtures for radio mutual exclusion ---

function setupReassociatedRadioDom() {
    // Two reassociated radios per form-owner, all DOM descendants of a common
    // ancestor <form id="parent"> — the layout that triggers the Chromium
    // parse-time desync. probeA owns {a, b} (b checked), probeB owns {c, d}
    // (c checked).
    var dom = new JSDOM('<!DOCTYPE html><html><body>'
        + '<form id="parent">'
        + '<input type="radio" name="grp" value="a" form="probeA" id="r-a">'
        + '<input type="radio" name="grp" value="b" form="probeA" id="r-b" checked>'
        + '<input type="radio" name="grp" value="c" form="probeB" id="r-c" checked>'
        + '<input type="radio" name="grp" value="d" form="probeB" id="r-d">'
        + '</form>'
        + '<form id="probeA"></form>'
        + '<form id="probeB"></form>'
        + '</body></html>');
    return {
        window:   dom.window,
        document: dom.window.document,
        a:        dom.window.document.getElementById('r-a'),
        b:        dom.window.document.getElementById('r-b'),
        c:        dom.window.document.getElementById('r-c'),
        d:        dom.window.document.getElementById('r-d')
    };
}

function setupSingleFormRadioDom() {
    var dom = new JSDOM('<!DOCTYPE html><html><body>'
        + '<form id="solo">'
        + '<input type="radio" name="grp" value="a" id="s-a">'
        + '<input type="radio" name="grp" value="b" id="s-b" checked>'
        + '</form>'
        + '</body></html>');
    return {
        document: dom.window.document,
        a:        dom.window.document.getElementById('s-a'),
        b:        dom.window.document.getElementById('s-b')
    };
}

function setupReassociatedRadioDomSingleChecked(checkedValue) {
    // Same parent + reassociated layout as setupReassociatedRadioDom, but only
    // ONE radio carries the `checked` HTML attribute. Use this when a test
    // would otherwise trip jsdom's two-quirks (parse-time same-name collision
    // and IDL-setter cross-form auto-mutex) — both surfaces in this fixture
    // shape only when multiple same-name radios race for `checked` state.
    function attr(v) { return checkedValue === v ? ' checked' : ''; }
    var dom = new JSDOM('<!DOCTYPE html><html><body>'
        + '<form id="parent">'
        + '<input type="radio" name="grp" value="a" form="probeA" id="r-a"' + attr('a') + '>'
        + '<input type="radio" name="grp" value="b" form="probeA" id="r-b"' + attr('b') + '>'
        + '<input type="radio" name="grp" value="c" form="probeB" id="r-c"' + attr('c') + '>'
        + '<input type="radio" name="grp" value="d" form="probeB" id="r-d"' + attr('d') + '>'
        + '</form>'
        + '<form id="probeA"></form>'
        + '<form id="probeB"></form>'
        + '</body></html>');
    return {
        window:   dom.window,
        document: dom.window.document
    };
}

function setupNoSharedParentRadioDom() {
    // Same per-form ownership pattern as setupReassociatedRadioDom but no
    // wrapping <form id="parent"> — the radios are not DOM descendants of
    // any common form. The browser-side IDL/attribute desync does not
    // surface in this shape.
    var dom = new JSDOM('<!DOCTYPE html><html><body>'
        + '<form id="probeA">'
        + '<input type="radio" name="grp" value="a" id="r-a">'
        + '<input type="radio" name="grp" value="b" id="r-b" checked>'
        + '</form>'
        + '<form id="probeB">'
        + '<input type="radio" name="grp" value="c" id="r-c" checked>'
        + '<input type="radio" name="grp" value="d" id="r-d">'
        + '</form>'
        + '</body></html>');
    return {
        document: dom.window.document,
        a:        dom.window.document.getElementById('r-a'),
        b:        dom.window.document.getElementById('r-b'),
        c:        dom.window.document.getElementById('r-c'),
        d:        dom.window.document.getElementById('r-d')
    };
}


// 05 - updateRadio: parse-time IDL/attribute desync reconciliation on init

describe('05 - updateRadio: parse-time IDL/attribute desync reconciliation', function () {
    it('reconciles .checked from the checked HTML attribute when they disagree on init', function () {
        var ctx = setupReassociatedRadioDom();
        // Construct the IDL/attribute desync explicitly: IDL `.checked = false`,
        // HTML attribute still set. This is the observable post-parse state for
        // the reproducer fixture — Chromium produces it via per-form-owner
        // unchecking after parse; jsdom happens to produce the same shape via
        // its own parser collision resolution. Either way, force the state so
        // the reconciliation path fires deterministically.
        ctx.b.checked = false;
        assert.equal(ctx.b.hasAttribute('checked'), true,
            'attribute should remain set even after the IDL is mutated');

        reconcileCheckedFromAttribute(ctx.b, /* isInit */ true);

        assert.equal(ctx.b.checked, true,
            'reconciliation should restore .checked to match the attribute');
        assert.equal(ctx.b.hasAttribute('checked'), true,
            'attribute should remain present (no-op on the attribute side)');
    });

    it('is a no-op outside init (user-triggered path must not flip values)', function () {
        var ctx = setupReassociatedRadioDom();
        ctx.b.checked = false;
        reconcileCheckedFromAttribute(ctx.b, /* isInit */ false);
        assert.equal(ctx.b.checked, false,
            'reconciliation must NOT fire for non-init updates');
    });

    it('is a no-op when IDL and attribute already agree (the common path)', function () {
        var ctx = setupReassociatedRadioDom();
        // value=a: IDL false, attribute absent — nothing to reconcile.
        assert.equal(ctx.a.checked, false);
        assert.equal(ctx.a.hasAttribute('checked'), false);
        reconcileCheckedFromAttribute(ctx.a, true);
        assert.equal(ctx.a.checked, false);
    });
});


// 05.b - updateRadio: form-owner-scoped mutual exclusion

describe('05.b - updateRadio: form-owner-scoped mutual exclusion', function () {
    it('peer set is filtered to same form-owner only', function () {
        var ctx = setupReassociatedRadioDom();
        var groupA = getRadioGroup(ctx.a, ctx.document);
        var groupB = getRadioGroup(ctx.c, ctx.document);
        assert.deepEqual(
            groupA.map(function (el) { return el.id; }).sort(),
            ['r-a', 'r-b'],
            'probeA group should contain only probeA-owned radios');
        assert.deepEqual(
            groupB.map(function (el) { return el.id; }).sort(),
            ['r-c', 'r-d'],
            'probeB group should contain only probeB-owned radios');
    });

    it('the unchecking loop cannot reach radios in other form-owners', function () {
        // The fix guarantees the production unchecking loop only iterates over
        // same-form-owner peers. We verify that by combining two assertions:
        //
        //   (a) the filtered group excludes radios in other form-owners, and
        //   (b) `applyMutualExclusion` (mirroring the production loop) only
        //       mutates members of the group it was given.
        //
        // jsdom limitation: jsdom's `.checked` IDL setter does cross-form
        // auto-mutex on form-reassociated radios — exactly the bug we are
        // fixing in production, but in jsdom's setter rather than in
        // updateRadio. Real browsers (Chromium) form-scope the IDL setter
        // mutex correctly. We therefore can't observe the cross-form
        // preservation end-state through `.checked` directly in jsdom; we
        // observe it through the FILTER + LOOP contract instead, which is
        // what the production fix actually changes.
        var ctx = setupReassociatedRadioDom();
        var groupA = getRadioGroup(ctx.a, ctx.document);

        // (a) filter excludes probeB radios
        assert.equal(groupA.indexOf(ctx.c), -1, 'rc must not appear in probeA group');
        assert.equal(groupA.indexOf(ctx.d), -1, 'rd must not appear in probeA group');

        // (b) loop only mutates group members. Snapshot rc/rd state immediately
        // before the loop runs (after any jsdom-side cross-form effects have
        // already settled), then verify the snapshot survives the loop.
        ctx.a.checked = true;
        var rcBefore = ctx.c.checked;
        var rcAttrBefore = ctx.c.hasAttribute('checked');
        var rdBefore = ctx.d.checked;
        var rdAttrBefore = ctx.d.hasAttribute('checked');

        applyMutualExclusion(groupA, ctx.a);

        assert.equal(ctx.a.checked, true, 'a stays checked');
        assert.equal(ctx.b.checked, false, 'b unchecked by the form-scoped loop');
        assert.equal(ctx.c.checked, rcBefore,
            'c.checked unchanged by the form-scoped loop (filter excluded it)');
        assert.equal(ctx.c.hasAttribute('checked'), rcAttrBefore,
            'c attribute unchanged by the form-scoped loop');
        assert.equal(ctx.d.checked, rdBefore,
            'd.checked unchanged by the form-scoped loop');
        assert.equal(ctx.d.hasAttribute('checked'), rdAttrBefore,
            'd attribute unchanged by the form-scoped loop');
    });
});


// 05.c - updateRadio: regressions and edge cases

describe('05.c - updateRadio: regressions and edge cases', function () {
    it('single-form non-regression: clicking one same-name radio unchecks the other', function () {
        var ctx = setupSingleFormRadioDom();
        ctx.a.checked = true;
        applyMutualExclusion(getRadioGroup(ctx.a, ctx.document), ctx.a);
        assert.equal(ctx.a.checked, true);
        assert.equal(ctx.b.checked, false);
    });

    it('distinct forms with no shared DOM parent: both per-form states preserved through init', function () {
        var ctx = setupNoSharedParentRadioDom();
        // No browser quirk here — jsdom parse already reflects the HTML attribute.
        assert.equal(ctx.b.checked, true);
        assert.equal(ctx.c.checked, true);
        reconcileCheckedFromAttribute(ctx.b, true);
        reconcileCheckedFromAttribute(ctx.c, true);
        assert.equal(ctx.b.checked, true,  'b stays checked through init');
        assert.equal(ctx.c.checked, true,  'c stays checked through init');
        assert.equal(ctx.a.checked, false, 'a stays unchecked through init');
        assert.equal(ctx.d.checked, false, 'd stays unchecked through init');
    });

    it('defaultChecked reflects the original attribute through init even when reconciliation fires', function () {
        var ctx = setupReassociatedRadioDom();
        ctx.b.checked = false;
        assert.equal(ctx.b.defaultChecked, true,
            'defaultChecked is parse-time and reflects the original attribute');
        reconcileCheckedFromAttribute(ctx.b, true);
        assert.equal(ctx.b.defaultChecked, true,
            'defaultChecked stays true through reconciliation');
    });

    it('programmatic submit per form collects the right value', function () {
        // Verify each form-owner's submission in isolation. Two separate
        // single-checked fixtures because jsdom's two-quirks (parse-time
        // collision and IDL-setter cross-form mutex) prevent setting up a
        // single fixture where both probeA and probeB simultaneously hold a
        // checked reassociated radio (see 05.b note). Real browsers form-scope
        // the IDL setter correctly, so in production both forms can have
        // independent checked radios — verified here per-form in isolation.
        var ctxA = setupReassociatedRadioDomSingleChecked('b');
        var dataA = new ctxA.window.FormData(ctxA.document.getElementById('probeA'));
        assert.equal(dataA.get('grp'), 'b',
            'probeA submits grp=b (its only owned-and-checked radio)');

        var ctxB = setupReassociatedRadioDomSingleChecked('c');
        var dataB = new ctxB.window.FormData(ctxB.document.getElementById('probeB'));
        assert.equal(dataB.get('grp'), 'c',
            'probeB submits grp=c (its only owned-and-checked radio)');
    });
});


// 06 - source inspection: pins on the two updateRadio fixes in main.js

describe('06 - source inspection: updateRadio fixes pin to main.js', function () {
    it('IDL/attribute desync reconciliation block is in updateRadio init path', function () {
        // Match the inline shape: `if ( isInit && !$el.checked && $el.hasAttribute('checked') )`
        // followed shortly by `$el.checked = true`.
        var re = /isInit\s*&&\s*!\$el\.checked\s*&&\s*\$el\.hasAttribute\(\s*['"]checked['"]\s*\)[\s\S]{0,80}\$el\.checked\s*=\s*true/;
        assert.ok(re.test(mainSrc),
            'IDL/attribute reconciliation block should be present in updateRadio');
    });

    it('radio-group filter scopes by form-owner (Array.prototype.filter.call shape)', function () {
        var re = /Array\.prototype\.filter\.call\(\s*\w+\s*,\s*function\s*\(\s*_r\s*\)\s*\{\s*return\s+_r\.form\s*===\s*\$el\.form\s*;?\s*\}\s*\)/;
        assert.ok(re.test(mainSrc),
            'form-owner filter should wrap the getElementsByName result');
    });

    it('comments in the validator stay framework-generic', function () {
        // Belt-and-suspenders for the no-consumer-references rule. The validator
        // source must not name any consuming application.
        assert.equal(/FRAMEWORK PATCH \(/.test(mainSrc), false,
            'validator must not carry consumer-tagged FRAMEWORK PATCH markers');
    });
});


// ============================================================================
// bindForm defaultChecked cache: parse-time IDL/attribute desync reconciliation
//
// Sister fix to the updateRadio reconciliation pinned in section 06. bindForm
// captures `$form.fieldsSet[id].defaultChecked` once per radio/checkbox in the
// input loop. The capture used to read the live IDL `.checked`, which lies for
// form-reassociated radios hit by Chromium's parse-time desync — the cache
// would hold FALSE for an attribute-bearing radio whose IDL was unchecked at
// parse, even though updateRadio's later reconciliation flipped the IDL back
// to TRUE. The capture now reads `.defaultChecked` (the IDL property that
// mirrors the HTML `checked` content attribute), which is parse-time stable
// and unaffected by the desync. resetFields then restores the
// originally-checked option correctly.
//
// Test layering: the production capture pattern is replayed below in
// `captureDefaultChecked`, mirroring the inline block in main.js. Source
// inspection in section 07.b pins the live shape so the replica stays honest.
// Since #49 the value-derived clause sits behind the per-form legacy opt-in
// (isCheckboxValueAsState($form)); the replica mirrors that gate with its
// third argument (omitted = spec mode, the default).
// ============================================================================

// Mirrors bindForm's fieldsSet.defaultChecked capture site (main.js ~line 5026).
function captureDefaultChecked($input, defaultValue, isLegacyValueAsState) {
    return (
        $input.defaultChecked
        ||
        isLegacyValueAsState
        && /^(true|on)$/.test(defaultValue)
        && /^(checkbox)$/i.test($input.type)
    ) ? true : false;
}

// The pre-fix shape (kept here ONLY to demonstrate the bug). Reads live IDL.
function captureDefaultCheckedPreFix($input, defaultValue) {
    return (
        /^(true|on)$/i.test($input.checked)
        ||
        /^(true|on)$/.test(defaultValue)
        && /^(checkbox)$/i.test($input.type)
    ) ? true : false;
}


// 07 - bindForm defaultChecked cache: capture from IDL .defaultChecked

describe('07 - bindForm defaultChecked cache: parse-time IDL/attribute desync reconciliation', function () {
    it('captures TRUE for a reassociated radio whose IDL .checked is desynced FALSE at bind time', function () {
        var ctx = setupReassociatedRadioDom();
        // Construct the IDL/attribute desync explicitly: HTML `checked` attribute
        // present, IDL `.checked = false` (the post-parse state Chromium produces
        // for the reproducer fixture). bindForm runs BEFORE updateRadio's
        // reconciliation, so the capture sees the desynced state.
        ctx.b.checked = false;
        assert.equal(ctx.b.hasAttribute('checked'), true,
            'attribute should remain set after the IDL is mutated');
        assert.equal(ctx.b.defaultChecked, true,
            'defaultChecked is parse-time and should reflect the original attribute');

        var captured = captureDefaultChecked(ctx.b, ctx.b.value);
        assert.equal(captured, true,
            'cache must capture TRUE so a later resetFields restores the originally-checked option');
    });

    it('pre-fix shape would have captured FALSE for the same desynced radio (regression demo)', function () {
        var ctx = setupReassociatedRadioDom();
        ctx.b.checked = false;
        var capturedOld = captureDefaultCheckedPreFix(ctx.b, ctx.b.value);
        assert.equal(capturedOld, false,
            'the pre-fix code path captures FALSE — the bug shape that resetFields then exhibits');
    });

    it('captures TRUE for a reassociated checkbox with the same desync shape', function () {
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="parent">'
            + '<input type="checkbox" name="optA" form="probeA" id="cb-a" checked>'
            + '<input type="checkbox" name="optA" form="probeB" id="cb-b" checked>'
            + '</form>'
            + '<form id="probeA"></form>'
            + '<form id="probeB"></form>'
            + '</body></html>');
        var $cbA = dom.window.document.getElementById('cb-a');
        $cbA.checked = false; // simulate the same parse-time desync for a checkbox

        assert.equal($cbA.hasAttribute('checked'), true);
        assert.equal($cbA.defaultChecked, true);
        assert.equal(captureDefaultChecked($cbA, ''), true,
            'reassociated checkbox cache must capture TRUE despite the desynced IDL');
    });

    it('non-regression: in-tree radio with the checked attribute captures TRUE', function () {
        var ctx = setupSingleFormRadioDom();
        // s-b carries the checked HTML attribute; jsdom's IDL agrees here.
        assert.equal(ctx.b.checked, true);
        assert.equal(ctx.b.defaultChecked, true);
        assert.equal(captureDefaultChecked(ctx.b, ctx.b.value), true);
    });

    it('non-regression: in-tree radio without the checked attribute captures FALSE', function () {
        var ctx = setupSingleFormRadioDom();
        assert.equal(ctx.a.checked, false);
        assert.equal(ctx.a.defaultChecked, false);
        assert.equal(captureDefaultChecked(ctx.a, ctx.a.value), false);
    });

    it('non-regression: programmatically-checked radio (no attribute) captures FALSE', function () {
        var ctx = setupSingleFormRadioDom();
        // s-a has no checked attribute; mutate IDL only — defaultChecked stays false,
        // so the cache stays FALSE. This is correct: the cache should reflect
        // server-rendered intent (the attribute), not transient runtime state.
        ctx.a.checked = true;
        assert.equal(ctx.a.defaultChecked, false,
            'IDL .checked mutation must not flip .defaultChecked');
        assert.equal(captureDefaultChecked(ctx.a, ctx.a.value), false,
            'cache reflects parse-time author intent, not transient IDL state');
    });

    it('checkbox defaultValue=on fires only under the legacy value-as-state opt-in (#49)', function () {
        // The value-derived branch covers the special checkbox case where the
        // framework was told the default is "on" via a separate input config
        // (defaultValue), without the HTML attribute being set. Since #49 that
        // clause is gated on the form's legacy opt-in — in spec mode (the
        // default) only the checked attribute decides the initial state.
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="f"><input type="checkbox" name="opt" id="cb"></form>'
            + '</body></html>');
        var $cb = dom.window.document.getElementById('cb');
        assert.equal($cb.defaultChecked, false,
            'no attribute, no parse-time default');
        assert.equal(captureDefaultChecked($cb, 'on'), false,
            'spec mode: defaultValue=on must NOT capture checked-by-default');
        assert.equal(captureDefaultChecked($cb, 'on', true), true,
            'legacy value-as-state mode: defaultValue=on still captures TRUE');
        assert.equal(captureDefaultChecked($cb, '', true), false,
            'legacy mode + no defaultValue should capture FALSE');
    });

    it('non-regression: defaultValue=on does NOT fire for a radio (the second-branch type guard holds)', function () {
        var ctx = setupSingleFormRadioDom();
        // s-a: no attribute. defaultValue='on' would trigger the second branch
        // ONLY when the type is checkbox — for radios it must NOT fire.
        assert.equal(ctx.a.defaultChecked, false);
        assert.equal(captureDefaultChecked(ctx.a, 'on', true), false,
            'radio + defaultValue=on must NOT capture TRUE even in legacy mode (the second branch is checkbox-only)');
    });
});


// 07.b - source inspection: pin the bindForm capture shape

describe('07.b - source inspection: bindForm defaultChecked capture pins to main.js', function () {
    it('the fieldsSet defaultChecked capture reads $inputs[f].defaultChecked (not .checked)', function () {
        // Look for the capture assignment site: starts with
        // `$form.fieldsSet[elId].defaultChecked = (` and the next non-whitespace
        // token must be `$inputs[f].defaultChecked`.
        var re = /\$form\.fieldsSet\[elId\]\.defaultChecked\s*=\s*\(\s*\$inputs\[f\]\.defaultChecked/;
        assert.ok(re.test(mainSrc),
            'capture must read $inputs[f].defaultChecked (the parse-time-stable IDL property)');
    });

    it('the pre-fix shape (reading $inputs[f].checked) is no longer in the capture site', function () {
        // The pre-fix line was:
        //   $form.fieldsSet[elId].defaultChecked = ( /^(true|on)$/i.test($inputs[f].checked) || ...
        // Guard against regression by asserting that ".checked" does NOT appear
        // as the immediate first conjunct of the capture.
        var re = /\$form\.fieldsSet\[elId\]\.defaultChecked\s*=\s*\(\s*\/\^\(true\|on\)\$\/i\.test\(\$inputs\[f\]\.checked\)/;
        assert.equal(re.test(mainSrc), false,
            'capture must not read $inputs[f].checked (the desync-prone live IDL property)');
    });

    it('the second branch (defaultValue=on for checkboxes) is preserved', function () {
        // Verify the special-case checkbox branch is still in place after the fix.
        var re = /\(\s*true\|on\s*\)\$\/\.test\(defaultValue\)\s*[\s\S]{0,40}\&\&\s*\/\^\(checkbox\)\$\/i\.test\(\$inputs\[f\]\.type\)/;
        assert.ok(re.test(mainSrc),
            'second-branch checkbox+defaultValue path should survive the fix');
    });

    it('the value-derived clause is gated on the legacy opt-in (#49) — mirrored by the replica third argument', function () {
        var re = /\$inputs\[f\]\.defaultChecked\s*\|\|\s*isCheckboxValueAsState\(\$form\)\s*&&\s*\/\^\(true\|on\)\$\//;
        assert.ok(re.test(mainSrc),
            'the (true|on) value clause must sit behind isCheckboxValueAsState($form); keep captureDefaultChecked in lockstep');
    });
});


// ============================================================================
// isRequired() radio-group resolution: form-owner-scoped serialize-time pick
//
// Sister fix to the updateRadio mutex scoping pinned in section 06. The
// isRequired validator's "radio group case" walks document.getElementsByName
// and picks the first .checked element. Without filtering by form-owner, a
// sibling form's checked radio (sharing the field name) is picked even when a
// different form is being serialized — local.data[name] gets the wrong value
// for the form-under-submission. The fix adds the same form-owner filter the
// updateRadio mutex now uses, scoped to $target.form (where $target is the
// validator-bound radio for this field).
//
// Test layering: the production radio-resolution branch is replayed below in
// `resolveRadioValue`, mirroring the inline block in form-validator.js. A
// pre-fix companion `resolveRadioValuePreFix` keeps the bug demonstrable.
// Source inspection in section 08.b pins the live shape so the replica stays
// honest.
// ============================================================================

// Mirrors form-validator.js's isRequired() radio-group branch (~line 1542).
// Returns the resolved radio value, or undefined when no in-form-owner radio
// is checked.
function resolveRadioValue($target, name, doc) {
    var rawRadios = doc.getElementsByName(name);
    var radios = Array.prototype.filter.call(rawRadios, function (_r) {
        return _r.form === $target.form;
    });
    for (var i = 0, len = radios.length; i < len; ++i) {
        if (radios[i].checked) {
            if (/true|false/.test(radios[i].value)) {
                return (/true/.test(radios[i].value)) ? true : false;
            }
            return radios[i].value;
        }
    }
    return undefined;
}

// The pre-fix shape (kept here ONLY to demonstrate the bug). No form-owner filter.
function resolveRadioValuePreFix($target, name, doc) {
    var radios = doc.getElementsByName(name);
    for (var i = 0, len = radios.length; i < len; ++i) {
        if (radios[i].checked) {
            if (/true|false/.test(radios[i].value)) {
                return (/true/.test(radios[i].value)) ? true : false;
            }
            return radios[i].value;
        }
    }
    return undefined;
}


// 08 - isRequired radio: form-owner-scoped serialize-time resolution
//
// Note on fixtures: the bug-demo tests use layouts WITHOUT a shared parent
// <form> (either setupNoSharedParentRadioDom, or bare-reassociation custom
// fixtures). The shared-parent reassociation layout (setupReassociatedRadioDom)
// triggers jsdom's parse-time same-name desync that the prior fixes worked
// around — the desync would mask the bug shape under test here. The serialize-
// time leak being fixed in this section is independent of that parse-time
// desync.

describe('08 - isRequired radio: form-owner-scoped serialize-time resolution', function () {

    it('serializing a form picks its OWN checked radio, not a sibling form\'s', function () {
        // Layout (setupNoSharedParentRadioDom): probeA owns {a (no check), b (checked)};
        // probeB owns {c (checked), d (no check)}. Submitting probeB should resolve to
        // probeB's own checked radio 'c', not the sibling probeA.b's 'b'.
        var ctx = setupNoSharedParentRadioDom();
        var resolved = resolveRadioValue(ctx.c, 'grp', ctx.document);
        assert.equal(resolved, 'c',
            'serialize-time resolution must pick probeB\'s own checked radio (c), not the cross-form sibling probeA.b');
    });

    it('pre-fix shape leaks the cross-form sibling (regression demo)', function () {
        // The pre-fix doc-wide walk picks the FIRST .checked in document order — probeA.b ('b'),
        // even when probeB is being serialized. This is the bug shape.
        var ctx = setupNoSharedParentRadioDom();
        var leaked = resolveRadioValuePreFix(ctx.c, 'grp', ctx.document);
        assert.equal(leaked, 'b',
            'pre-fix walks doc order and leaks the sibling form\'s checked value');
    });

    it('serializing a form with NO checked radio returns undefined (does not inherit a sibling\'s)', function () {
        // probeA: a (false), b (false) — none checked. probeB: c (true), d (false).
        // The pre-fix would falsely return 'c' for probeA's serialization (sibling leak masking
        // a "no value selected" state as a valid value). The fix returns undefined correctly.
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="probeA">'
            + '<input type="radio" name="grp" value="a" id="r-a">'
            + '<input type="radio" name="grp" value="b" id="r-b">'
            + '</form>'
            + '<form id="probeB">'
            + '<input type="radio" name="grp" value="c" id="r-c" checked>'
            + '<input type="radio" name="grp" value="d" id="r-d">'
            + '</form>'
            + '</body></html>');
        var $a = dom.window.document.getElementById('r-a');
        var resolved = resolveRadioValue($a, 'grp', dom.window.document);
        assert.equal(resolved, undefined,
            'no probeA-owned radio is checked → resolution must be undefined, not the cross-form sibling\'s value');
    });

    it('pre-fix shape: serializing a form with NO checked radio falsely returns the sibling\'s value', function () {
        // Same fixture as the previous test. Pre-fix returns 'c' — a false positive that hides the
        // "no value" state and would mark isRequired as valid against the wrong value.
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="probeA">'
            + '<input type="radio" name="grp" value="a" id="r-a">'
            + '<input type="radio" name="grp" value="b" id="r-b">'
            + '</form>'
            + '<form id="probeB">'
            + '<input type="radio" name="grp" value="c" id="r-c" checked>'
            + '<input type="radio" name="grp" value="d" id="r-d">'
            + '</form>'
            + '</body></html>');
        var $a = dom.window.document.getElementById('r-a');
        var leaked = resolveRadioValuePreFix($a, 'grp', dom.window.document);
        assert.equal(leaked, 'c',
            'pre-fix returns "c" for probeA serialization despite probeA having no checked radio — false positive');
    });

    it('EDIT-path equivalent: form-owner filter ignores doc-order-first cross-form sibling', function () {
        // Sibling form (probeB) appears FIRST in document order, with its checked radio 'c'.
        // Target form (probeA) is after, with its OWN checked radio 'b'. The pre-fix walk
        // picks the doc-order-first checked = 'c' (sibling leak). The post-fix filter scopes
        // to probeA → 'b'. This shape models the EDIT-path symptom: prior persisted state in
        // a sibling form clobbering the target form's serialization at submit time.
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="probeB">'
            + '<input type="radio" name="grp" value="c" id="r-c" checked>'
            + '<input type="radio" name="grp" value="d" id="r-d">'
            + '</form>'
            + '<form id="probeA">'
            + '<input type="radio" name="grp" value="a" id="r-a">'
            + '<input type="radio" name="grp" value="b" id="r-b" checked>'
            + '</form>'
            + '</body></html>');
        var $b = dom.window.document.getElementById('r-b');
        var resolved = resolveRadioValue($b, 'grp', dom.window.document);
        assert.equal(resolved, 'b',
            'serialize-time resolution must pick probeA\'s checked radio (b), independent of probeB.c which appears first in document order');
    });

    it('EDIT-path equivalent: pre-fix shape returns the doc-order-first cross-form sibling (regression demo)', function () {
        // Same fixture as the previous test. Pre-fix walks doc order and picks 'c' from probeB.
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="probeB">'
            + '<input type="radio" name="grp" value="c" id="r-c" checked>'
            + '<input type="radio" name="grp" value="d" id="r-d">'
            + '</form>'
            + '<form id="probeA">'
            + '<input type="radio" name="grp" value="a" id="r-a">'
            + '<input type="radio" name="grp" value="b" id="r-b" checked>'
            + '</form>'
            + '</body></html>');
        var $b = dom.window.document.getElementById('r-b');
        var leaked = resolveRadioValuePreFix($b, 'grp', dom.window.document);
        assert.equal(leaked, 'c',
            'pre-fix returns "c" from probeB despite probeA being the form under serialization — sibling leak');
    });

    it('non-regression: single-form-owner shape resolves identically pre-fix and post-fix', function () {
        // No reassociation, no cross-form ambiguity — both shapes converge on the same answer.
        var ctx = setupSingleFormRadioDom();
        var resolvedNew = resolveRadioValue(ctx.b, 'grp', ctx.document);
        var resolvedOld = resolveRadioValuePreFix(ctx.b, 'grp', ctx.document);
        assert.equal(resolvedNew, 'b');
        assert.equal(resolvedOld, 'b');
    });

    it('non-regression: bare reassociation (form="X") without shared parent resolves correctly', function () {
        // Reassociated radios that are NOT DOM descendants of any shared form. The form-owner
        // filter still scopes correctly via $target.form, regardless of how ownership was
        // declared (DOM descent vs form="X" attribute).
        // The forms come FIRST: parsed ahead of them, both checked radios would share a null form
        // owner, so the later one unchecks the earlier (the HTML radio-group rule, applied by
        // Chromium and by jsdom from 30.1.0).
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="probeA"></form>'
            + '<form id="probeB"></form>'
            + '<input type="radio" name="grp" value="a" form="probeA" id="r-a">'
            + '<input type="radio" name="grp" value="b" form="probeA" id="r-b" checked>'
            + '<input type="radio" name="grp" value="c" form="probeB" id="r-c" checked>'
            + '<input type="radio" name="grp" value="d" form="probeB" id="r-d">'
            + '</body></html>');
        var $b = dom.window.document.getElementById('r-b');
        var resolved = resolveRadioValue($b, 'grp', dom.window.document);
        assert.equal(resolved, 'b',
            'form-owner filter scopes correctly for reassociated radios regardless of DOM-descent vs form-attribute ownership');
    });

    it('boolean-value branch: "true"/"false" string is coerced to boolean', function () {
        // Single-form sanity check on the boolean coercion path inside the resolution branch.
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="probeA">'
            + '<input type="radio" name="opt" value="false" id="r-false">'
            + '<input type="radio" name="opt" value="true" id="r-true" checked>'
            + '</form>'
            + '</body></html>');
        var $true = dom.window.document.getElementById('r-true');
        var resolved = resolveRadioValue($true, 'opt', dom.window.document);
        assert.equal(resolved, true,
            'value="true" is coerced to boolean true');
    });

    it('boolean-value branch: form-owner filter still applies', function () {
        // Cross-form same-name boolean radios in sibling forms (no shared parent). probeA has
        // value="false" checked; probeB has value="true" checked. Serializing probeA must
        // return false (NOT true from probeB).
        var dom = new JSDOM('<!DOCTYPE html><html><body>'
            + '<form id="probeA">'
            + '<input type="radio" name="opt" value="false" id="r-pa-false" checked>'
            + '<input type="radio" name="opt" value="true" id="r-pa-true">'
            + '</form>'
            + '<form id="probeB">'
            + '<input type="radio" name="opt" value="false" id="r-pb-false">'
            + '<input type="radio" name="opt" value="true" id="r-pb-true" checked>'
            + '</form>'
            + '</body></html>');
        var $a = dom.window.document.getElementById('r-pa-false');
        var resolved = resolveRadioValue($a, 'opt', dom.window.document);
        assert.equal(resolved, false,
            'probeA serialization returns false (its own checked radio), not true from probeB');
    });
});


// 08.b - source inspection: pin the isRequired form-owner filter shape

describe('08.b - source inspection: isRequired form-owner filter pins to form-validator.js', function () {

    it('radio-group filter scopes by form-owner via $target.form (Array.prototype.filter.call shape)', function () {
        // Match the inline shape:
        //   Array.prototype.filter.call(<rawRadios>, function (_r) { return _r.form === $target.form; })
        var re = /Array\.prototype\.filter\.call\(\s*\w+\s*,\s*function\s*\(\s*_r\s*\)\s*\{\s*return\s+_r\.form\s*===\s*\$target\.form\s*;?\s*\}\s*\)/;
        assert.ok(re.test(fvSrc),
            'form-owner filter should wrap the getElementsByName result in isRequired\'s radio branch');
    });

    it('the pre-fix shape (getElementsByName immediately followed by for-loop on radios.length) is gone', function () {
        // The pre-fix line was:
        //   var radios = document.getElementsByName(this.name);
        //   for (var i = 0, len = radios.length; i < len; ++i) {
        // The post-fix shape inserts a closure-captured $target plus an
        // Array.prototype.filter.call(rawRadios, ...) step between
        // getElementsByName and the for-loop. Guard against regression by
        // asserting the pre-fix immediate sequence is no longer present.
        var preFixRe = /var\s+radios\s*=\s*document\.getElementsByName\(\s*this\.name\s*\)\s*;\s*for\s*\(\s*var\s+i\s*=\s*0\s*,\s*len\s*=\s*radios\.length/;
        assert.equal(preFixRe.test(fvSrc), false,
            'pre-fix shape (getElementsByName immediately followed by for-loop) must not be present at the radio site');
    });

    it('closure-captures this.target into $target before the filter (so the inner function can see it)', function () {
        // Match: var $target = this.target;
        // Anchored close to the radio resolution site rather than file-wide to keep the pin tight.
        var re = /var\s+\$target\s*=\s*this\.target\s*;\s*var\s+rawRadios\s*=\s*document\.getElementsByName\(\s*this\.name\s*\)/;
        assert.ok(re.test(fvSrc),
            'closure capture (var $target = this.target;) must precede the getElementsByName call so the filter can read $target.form');
    });

    it('form-validator.js comments stay framework-generic (no consumer-app references)', function () {
        // Belt-and-suspenders for the no-consumer-references rule. The validator
        // source must not name any consuming application.
        assert.equal(/FRAMEWORK PATCH \(/.test(fvSrc), false,
            'form-validator.js must not carry consumer-tagged FRAMEWORK PATCH markers');
    });
});
