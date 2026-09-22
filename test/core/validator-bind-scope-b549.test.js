/**
 * validator-bind-scope — the boot scan binds only OPTED-IN forms (#B549).
 *
 * The published contract (docs guide "Binding by form id": "A form with neither a
 * matching rule set nor the attribute is left untouched") was violated by the boot
 * scan in `init()`: every <form> in the document reached `bindForm` — the `else`
 * arm meant for one edge case (a form containing `<input name="id">`) ended in an
 * unconditional bind — after being minted a generated `form.<uuid>` id. Once ANY
 * `forms/rules/*.json` existed, a plain login form became an always-XHR submit.
 *
 * Fix: a pure predicate `isFormOptedIn($form, rules)` consulted at the TOP of the
 * scan loop, before the id mint. Opted in = a `data-gina-form-*` attribute (rule,
 * event handlers, submit overrides, upload staging…), an EXISTING id naming a
 * registered rule (`-`→`.`), or a virtual `gina-upload-*` id. Anything else is
 * skipped: no minted id, no `$forms` entry, no submit proxy. The EXPLICIT entry
 * points — `validateFormById` (nav rebind, popin bind, app code) and
 * `getFormById`→`initForm` — are deliberately NOT gated: an explicit call is the
 * opt-in.
 *
 * A jsdom boot of the real client instance is not feasible here (see the auto-boot
 * test), so per the established idiom the behavioural arms EXECUTE THE EXTRACTED
 * REAL BYTES (control-gated) of the predicate and of the scan loop, and a FROZEN
 * pre-fix replica of the loop is the discriminator that proves the harness can
 * fail.
 *
 * Shape: §01 source pins · §02 predicate (extracted) · §03 scan loop (extracted)
 * · §04 pre-fix replica subtract · §05 dist fidelity.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var { JSDOM } = require('jsdom');

var FW = require('../fw');
require(path.join(FW, '../../utils/prototypes')); // Object.prototype.count()

var MAIN_PATH = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var MAIN_SRC  = fs.readFileSync(MAIN_PATH, 'utf8');
var DIST_MIN  = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

function stripComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/** Brace-walk from a declaration string to its matching close; null if not found. */
function braceExtract(src, decl) {
    var s = src.indexOf(decl);
    if (s < 0) { return null; }
    var depth = 0, started = false;
    for (var i = s; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { return src.substring(s, i + 1); } }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Control-gated extractions of the REAL shipped bytes
// ---------------------------------------------------------------------------
var PRED_DECL  = 'function isFormOptedIn($form, rules)';
var predSrc    = braceExtract(MAIN_SRC, PRED_DECL);

var SCAN_START = "$allForms = document.getElementsByTagName('form');";
var SCAN_END   = '// #B175: no init-time XHR';
var scanSrc = (function () {
    var s = MAIN_SRC.indexOf(SCAN_START);
    var e = MAIN_SRC.indexOf(SCAN_END);
    return (s > -1 && e > s) ? MAIN_SRC.substring(s, e) : null;
})();

function makePredicate() {
    return new Function('return (' + predSrc + ');')();
}

function makeDoc(html) {
    return new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>').window;
}

/**
 * Runs a scan-loop slice (real or replica) against a document with stubbed
 * collaborators; returns what got bound and what ids the DOM ended up with.
 */
function runScan(loopSrc, win, rulesMap, predicate) {
    var bound = [];
    var n = 0;
    var uuid     = function () { return 'U' + (++n); };
    var bindForm = function ($t) { bound.push($t.getAttribute('id')); };
    var merge    = function (a, b) { return Object.assign({}, a, b); };
    var JSONc    = { clone: function (o) { return JSON.parse(JSON.stringify(o)); } };
    var instance = { $forms: {}, rules: {} };
    var local    = { rules: rulesMap };
    var gina     = { forms: { rules: rulesMap } };
    var $validator = { id: null, target: null, rules: {} };
    var body = stripComments(loopSrc);
    var fn = new Function('document', 'uuid', 'bindForm', 'merge', 'JSON', 'instance', 'local',
        'gina', '$validator', 'rules', 'isFormOptedIn',
        'var id = null, $target = null, i = 0, $forms = [], $allForms;\n' + body +
        '\nreturn { instance: instance };');
    // `JSON` is shadowed on purpose: the loop calls JSON.clone(); give it clone + the real parse/stringify.
    var JSONshim = Object.assign({}, JSON, JSONc);
    var out = fn(win.document, uuid, bindForm, merge, JSONshim, instance, local, gina, $validator,
        rulesMap, predicate);
    var ids = Array.prototype.map.call(win.document.getElementsByTagName('form'), function (f) {
        return f.getAttribute('id');
    });
    return { bound: bound, ids: ids, forms: Object.keys(out.instance.$forms) };
}

var RULES = { shorten: { url: { isRequired: true } }, 'my.form': { x: { isRequired: true } } };

var PAGE =
    '<form id="f-rule" data-gina-form-rule="shorten" method="post" action="/shorten"></form>' +
    '<form id="f-handler" data-gina-form-event-on-submit-success="onOk" method="post" action="/x"></form>' +
    '<form id="shorten" method="post" action="/y"></form>' +                       // id names a rule
    '<form id="my-form" method="post" action="/z"></form>' +                       // dash→dot names a rule
    '<form id="gina-upload-photo" method="post" action="/u"></form>' +             // virtual upload form
    '<form method="post" action="/login"></form>' +                                // BARE, id-less
    '<form id="bare-with-id" method="post" action="/logout"></form>';              // BARE, id no rule

var EXPECT_BOUND = ['f-rule', 'f-handler', 'shorten', 'my-form', 'gina-upload-photo'];

describe('validator-bind-scope §01 — source pins', function () {

    it('01.1 - the predicate is declared exactly once, and the scan slice extracts (controls)', function () {
        var active = stripComments(MAIN_SRC);
        var decls = active.match(/function isFormOptedIn\(\$form, rules\)/g) || [];
        assert.equal(decls.length, 1, 'isFormOptedIn must be declared exactly once');
        assert.ok(predSrc && predSrc.indexOf('data-gina-form-') > -1, 'predicate extraction looks wrong');
        assert.ok(scanSrc && scanSrc.indexOf('bindForm') > -1, 'scan-loop extraction looks wrong');
    });

    it('01.2 - in the scan loop the opt-in gate precedes the id mint (ordering, comment-stripped)', function () {
        var slice = stripComments(scanSrc);
        var gate  = slice.indexOf('isFormOptedIn($allForms[f]');
        var mint  = slice.indexOf("'form.' + uuid()");
        assert.ok(gate > -1, 'the scan loop must consult isFormOptedIn');
        assert.ok(mint > -1, 'id mint not found in the scan loop');
        assert.ok(gate < mint, 'the gate must run BEFORE a generated id is minted — "left untouched" means no DOM write');
        assert.ok(/isFormOptedIn\(\$allForms\[f\],\s*local\.rules\)\s*\)\s*\{\s*continue;/.test(slice),
            'the gate must `continue` the loop (skip: no $forms entry, no bind)');
    });

    it('01.3 - the EXPLICIT entry points are NOT gated (an explicit call is the opt-in)', function () {
        var initForm = stripComments(braceExtract(MAIN_SRC, 'var initForm = function ($form)') || '');
        var byId     = stripComments(braceExtract(MAIN_SRC, 'var validateFormById = function(formId, customRule)') || '');
        assert.ok(initForm.length > 0 && byId.length > 0, 'explicit entry points not found');
        assert.equal(initForm.indexOf('isFormOptedIn'), -1, 'initForm (getFormById path) must keep binding on demand');
        assert.equal(byId.indexOf('isFormOptedIn'), -1, 'validateFormById (nav rebind / popin bind / app code) must keep binding on demand');
    });
});

describe('validator-bind-scope §02 — the predicate, executed from the shipped bytes', function () {
    var pred = predSrc ? makePredicate() : null;
    var win  = makeDoc(PAGE);
    var q    = function (sel) { return win.document.querySelector(sel); };

    it('02.1 - opted in: rule attribute · other data-gina-form-* attribute · id naming a rule · dash→dot id · gina-upload-* id', function () {
        assert.ok(pred, 'predicate not extracted');
        assert.equal(pred(q('#f-rule'), RULES), true);
        assert.equal(pred(q('#f-handler'), RULES), true);
        assert.equal(pred(q('#shorten'), RULES), true);
        assert.equal(pred(q('#my-form'), RULES), true);
        assert.equal(pred(q('#gina-upload-photo'), RULES), true);
    });

    it('02.2 - left alone: a bare form, id-less or with an id that names no rule; and non-forms', function () {
        assert.ok(pred, 'predicate not extracted');
        assert.equal(pred(q('form[action="/login"]'), RULES), false);
        assert.equal(pred(q('#bare-with-id'), RULES), false);
        assert.equal(pred(null, RULES), false);
        assert.equal(pred({}, RULES), false);
        // no rules at all: attribute-bearing forms still opt in, id-only ones do not
        assert.equal(pred(q('#f-handler'), {}), true);
        assert.equal(pred(q('#shorten'), {}), false);
    });
});

describe('validator-bind-scope §03 — the scan loop, executed from the shipped bytes', function () {

    it('03.1 - binds exactly the opted-in forms, in document order', function () {
        assert.ok(scanSrc && predSrc, 'extractions missing');
        var r = runScan(scanSrc, makeDoc(PAGE), RULES, makePredicate());
        assert.deepEqual(r.bound, EXPECT_BOUND);
    });

    it('03.2 - a bare form is LEFT UNTOUCHED: no minted id, no $forms entry', function () {
        var r = runScan(scanSrc, makeDoc(PAGE), RULES, makePredicate());
        assert.equal(r.ids[5], null, 'the id-less bare form must not be minted an id');
        assert.equal(r.forms.indexOf('bare-with-id'), -1, 'no $forms entry for a bare id-bearing form');
        assert.ok(!r.forms.some(function (k) { return /^form\.U\d+$/.test(k); }), 'no $forms entry under a minted id');
        assert.deepEqual(r.forms.sort(), EXPECT_BOUND.slice().sort());
    });

    it('03.3 - tutorial shape: rules declared, one rule-bound form, plain auth forms stay native', function () {
        var win = makeDoc(
            '<form id="shorten-form" data-gina-form-rule="shorten" method="post" action="/shorten"></form>' +
            '<form method="post" action="/login"></form>' +
            '<form method="post" action="/logout"></form>');
        var r = runScan(scanSrc, win, { shorten: RULES.shorten }, makePredicate());
        assert.deepEqual(r.bound, ['shorten-form']);
        assert.deepEqual(r.ids, ['shorten-form', null, null]);
    });
});

describe('validator-bind-scope §04 — pre-fix replica subtract (the discriminator)', function () {
    // FROZEN copy of the pre-#B549 scan loop, verbatim minus comments: every form was
    // minted an id and reached bindForm through the `else` arm. If this arm ever
    // stops showing the defect, the HARNESS lost its teeth — not the fix.
    var PRE_FIX_LOOP =
        "$allForms = document.getElementsByTagName('form');\n" +
        "for (var f=0, len = $allForms.length; f<len; ++f) {\n" +
        "    if ($allForms[f].getAttribute) {\n" +
        "        id = $allForms[f].getAttribute('id') || 'form.' + uuid();\n" +
        "        if ( id !== $allForms[f].getAttribute('id') ) { $allForms[f].setAttribute('id', id) }\n" +
        "    } else { id = 'form.' + uuid(); $allForms[f].setAttribute('id', id) }\n" +
        "    $validator.id = id;\n" +
        "    $validator.target = $allForms[f];\n" +
        "    instance.$forms[id] = merge({}, $validator);\n" +
        "    var customRule = $allForms[f].getAttribute('data-gina-form-rule');\n" +
        "    if (customRule) { customRule = customRule.replace(/\\-|\\//g, '.'); customRule = local.rules[customRule]; }\n" +
        "    if ( typeof(id) == 'string' && typeof(local.rules[id.replace(/\\-/g, '.')]) != 'undefined' || typeof(customRule) == 'object' ) {\n" +
        "        $target = instance.$forms[id].target; bindForm($target); ++i\n" +
        "    } else {\n" +
        "        $target = instance.$forms[$allForms[f].id].target; bindForm($target)\n" +
        "    }\n" +
        "}\n";

    it('04.1 - the pre-fix loop bound EVERY form and minted ids for the bare ones (defect reproduced)', function () {
        var r = runScan(PRE_FIX_LOOP, makeDoc(PAGE), RULES, function () { return true; });
        assert.equal(r.bound.length, 7, 'pre-fix: all 7 forms bound');
        assert.match(r.ids[5], /^form\.U\d+$/, 'pre-fix: the id-less bare form was minted an id');
        assert.ok(r.bound.indexOf('bare-with-id') > -1, 'pre-fix: the bare id-bearing form was bound');
    });

    it('04.2 - same document, same harness: fixed loop vs pre-fix loop DISAGREE on exactly the bare forms', function () {
        var pre  = runScan(PRE_FIX_LOOP, makeDoc(PAGE), RULES, function () { return true; });
        var post = runScan(scanSrc, makeDoc(PAGE), RULES, makePredicate());
        var onlyPre = pre.bound.filter(function (b) { return post.bound.indexOf(b) < 0; });
        assert.equal(onlyPre.length, 2, 'the delta is the two bare forms');
        assert.ok(onlyPre.indexOf('bare-with-id') > -1);
        assert.ok(onlyPre.some(function (b) { return /^form\.U\d+$/.test(b); }));
        assert.deepEqual(post.bound, EXPECT_BOUND, 'and nothing opted-in was lost');
    });
});

describe('validator-bind-scope §05 — dist fidelity', function () {
    // The predicate's attribute-prefix regex survives minification as a regex literal.
    // Wrap-agnostic; validated RED against the pre-fix gina.min.js before the rebuild.
    it('05.1 - the built bundle carries the opt-in prefix test', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8');
        var hits = (min.match(/\/\^data-gina-form-\/i/g) || []).length;
        assert.ok(hits >= 1, 'gina.min.js must carry /^data-gina-form-/i — rebuild the plugin after the src edit');
    });
});
