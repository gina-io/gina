'use strict';
/**
 * #B241 — a bracket-notation RULE KEY silently never enforced on the server
 * form-body path.
 *
 * `parseRules` canonicalizes every rule key to a dotted path ("must be a
 * real path"): a bracket key `a[b]` becomes `a.b`, and a nested rule tree
 * flattens to its dotted leaves. `backendInit`'s fields map kept the RAW
 * posted keys, so the per-field rule lookup missed and the field was
 * skipped with NO warn — fail-open for every rule-keyed directive on such
 * a key: the missing CHECK (is* rules) and the missing DROP (`exclude`)
 * alike. BOTH production wire shapes were affected: flat bracket keys (the
 * client posts the engine's name-keyed data as JSON and the server's
 * application/json branch does no bracket expansion) and nested objects
 * (the multipart and urlencoded parsers expand bracket names).
 *
 * Fix — alias-augmentation in backendInit, server-only, engine untouched:
 * synthesized dotted-canon entries join the rules ALONGSIDE the raw keys
 * (originals kept, so dollar-token substitution keeps reading the raw
 * names), and the egress folds alias outcomes back onto the original
 * addressing (error keys -> the DOM-name bracket form the client renders
 * against; `.data` keeps its materialized shape with exclusions and
 * transforms applied, exclusion-emptied parents pruned along that alias's
 * path only).
 *
 * Design substrate + executable rehearsal (19 arms on the real engine
 * bytes): internal ledger entry #B241 and its arc probes. Related filings
 * out of the same pass: #B245 (isRequired+trim order/leading-whitespace
 * spurious rejection — a FLAT-path defect the newly-joined keys now
 * inherit by parity, asserted here in 02.6) and #B244 (unrelated surface).
 *
 * Every arm uses arm-unique field names: `instance.rules` is process-sticky
 * across Validator() calls (parseRules re-parses, but nested-tree parent
 * keys short-circuit on the already-defined guard), so a shared name would
 * let one arm's rule set leak into another's.
 *
 * Red-first buckets (pre-fix bytes):
 *   MUST-RED  — 01.2/01.3 (the augment/restore integration is absent),
 *               02.1-02.6 (the enforce/drop/parity arms), 04.1/04.2
 *               (dist pins).
 *   MUST-GREEN (premises/controls) — 01.1/01.4, 03.1-03.8.
 * At the src-fixed/dist-stale midstate only 04.x stays red.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');

var FW = require('../fw');

process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
process.setMaxListeners(0);
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
/* global getContext, setContext */
if (typeof getContext('gina') === 'undefined') { setContext('gina', { forms: null }); }
setContext('bundle', 'bracketrulesbundle');

var MAIN_PATH = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var MAIN_SRC = fs.readFileSync(MAIN_PATH, 'utf8');
var DIST_RAW_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var Validator = require(MAIN_PATH);

/** backendInit block slicer — declaration form to the next declaration. */
function backendBlock(src) {
    var start = src.indexOf('var backendInit = function (');
    var end = src.indexOf('var setOptions', start);
    assert.ok(start > -1 && end > start, 'backendInit block not found');
    return src.slice(start, end);
}

function drive(rules, data) {
    var res = Validator(JSON.parse(JSON.stringify(rules)), JSON.parse(JSON.stringify(data)), 'bracket-rules-form');
    var errs = {};
    for (var f in res.error || {}) { errs[f] = Object.keys(res.error[f] || {}); }
    return { valid: res.isValid(), errs: errs, data: res.data };
}

// ---------------------------------------------------------------------------
// §01 — source pins on the backendInit alias integration
// ---------------------------------------------------------------------------
describe('validator-server-bracket-rules §01 — source pins', function () {

    it('01.1 - control: the slicer can fail', function () {
        assert.throws(function () { backendBlock('nothing here'); }, /not found/);
        assert.ok(backendBlock(MAIN_SRC).length > 200, 'real block sliced');
    });

    it('01.2 - backendInit augments inside the with-rules branch and restores after validate', function () {
        var block = backendBlock(MAIN_SRC);
        var gateIdx = block.indexOf('rules.count() > 0');
        var augIdx = block.indexOf('backendAliasAugment(fields, data)');
        var valIdx = block.indexOf('validate($form, fields, null, instance.rules, null, culture)');
        var resIdx = block.indexOf('backendRestoreAliases(');
        assert.ok(gateIdx > -1, 'the with-rules gate exists');
        assert.ok(augIdx > gateIdx, 'the augment call sits INSIDE the with-rules branch (the no-rules branch must keep the payload verbatim)');
        assert.ok(valIdx > augIdx, 'aliases are synthesized BEFORE the engine runs');
        assert.ok(resIdx > valIdx, 'the restore folds outcomes back AFTER the engine returns');
    });

    it('01.3 - the alias helpers exist (declaration forms)', function () {
        assert.ok(MAIN_SRC.indexOf('var backendAliasAugment = function (') > -1);
        assert.ok(MAIN_SRC.indexOf('var backendRestoreAliases = function (') > -1);
        assert.ok(MAIN_SRC.indexOf('var backendAliasToBracketName = function (') > -1);
    });

    it('01.4 - premise: the no-rules branch stays a bare engine construction', function () {
        var block = backendBlock(MAIN_SRC);
        assert.ok(block.indexOf('new FormValidator(fields, undefined, undefined, undefined, culture)') > -1,
            'no-rules payloads keep the verbatim contract');
    });
});

// ---------------------------------------------------------------------------
// §02 — behaviour: the enforce/drop arms (all fail-open pre-fix)
// ---------------------------------------------------------------------------
describe('validator-server-bracket-rules §02 — bracket/nested rule keys enforce', function () {

    it('02.1 - flat-bracket wire: a required bracket-keyed field rejects empty', function () {
        var r = drive({ 'q21a[q21b]': { isRequired: true } }, { 'q21a[q21b]': '' });
        assert.equal(r.valid, false, 'the field must be adjudicated, not skipped');
        assert.deepEqual(r.errs['q21a[q21b]'], ['isRequired'], 'the error is keyed by the DOM-name bracket form');
    });

    it('02.2 - nested wire: the same rule joins the expanded-object shape', function () {
        var r = drive({ 'q22a[q22b]': { isRequired: true } }, { q22a: { q22b: '' } });
        assert.equal(r.valid, false);
        assert.deepEqual(r.errs['q22a[q22b]'], ['isRequired']);
    });

    it('02.3 - a nested-AUTHORED rule tree enforces its leaf', function () {
        var r = drive({ q23a: { q23b: { isRequired: true } } }, { q23a: { q23b: '' } });
        assert.equal(r.valid, false);
        assert.deepEqual(r.errs['q23a[q23b]'], ['isRequired']);
    });

    it('02.4 - the DROP half: a bracket-keyed exclude strips the value from the data egress', function () {
        var r = drive({ 'q24a[q24s]': { exclude: true }, q24n: { isRequired: true } },
            { 'q24a[q24s]': 'LEAKq24', q24n: 'ok' });
        assert.equal(r.valid, true);
        assert.equal(JSON.stringify(r.data).indexOf('LEAKq24'), -1, 'the excluded value must not survive anywhere in .data');
        assert.equal(r.data.q24n, 'ok');
    });

    it('02.5 - a transform through the alias lands at the original spot (parity with flat)', function () {
        var flat = drive({ q25f: { trim: true, isRequired: true } }, { q25f: '  x  ' });
        var r = drive({ 'q25a[q25b]': { trim: true, isRequired: true } }, { 'q25a[q25b]': '  x  ' });
        assert.equal(flat.valid, true, 'flat control');
        assert.equal(r.valid, true);
        assert.ok(r.data && r.data.q25a, 'materialized shape kept');
        assert.equal(r.data.q25a.q25b, flat.data.q25f, 'the trimmed value, exactly as the flat path produces it');
    });

    it('02.6 - defect-parity: the newly-joined key tracks the flat path across the #B245 fix', function () {
        // {isRequired, trim} + LEADING padding was wrongly invalid on the FLAT path
        // (#B245 — the leading-only emptiness anchor; fixed). Parity means the
        // bracket key gets the SAME verdict either side of the fix: pre-fix both
        // rejected (the shape this arm pinned then), post-fix both accept and
        // store the trimmed value.
        var flat = drive({ q26f: { isRequired: true, trim: true } }, { q26f: '  x  ' });
        var r = drive({ 'q26a[q26b]': { isRequired: true, trim: true } }, { 'q26a[q26b]': '  x  ' });
        assert.equal(r.valid, flat.valid, 'same verdict as flat');
        assert.equal(flat.valid, true, 'the #B245 fix baseline: leading-padded non-empty input is accepted');
        assert.equal(r.data.q26a.q26b, flat.data.q26f, 'same healed value, restored addressing');
        assert.equal(flat.data.q26f, 'x', 'trim owns the stored shape (both ends stripped since #B245)');
    });
});

// ---------------------------------------------------------------------------
// §03 — identity and preserved behaviours (green PRE and POST fix)
// ---------------------------------------------------------------------------
describe('validator-server-bracket-rules §03 — controls and preserved behaviours', function () {

    it('03.1 - engine control: flat empty rejects, flat filled passes', function () {
        var bad = drive({ q31u: { isRequired: true } }, { q31u: '' });
        var ok = drive({ q31v: { isRequired: true } }, { q31v: 'x' });
        assert.equal(bad.valid, false);
        assert.deepEqual(bad.errs.q31u, ['isRequired']);
        assert.equal(ok.valid, true);
    });

    it('03.2 - drop-instrument control: a flat exclude strips its value', function () {
        var r = drive({ q32s: { exclude: true }, q32n: { isRequired: true } }, { q32s: 'LEAKq32', q32n: 'ok' });
        assert.equal(r.valid, true);
        assert.equal(JSON.stringify(r.data).indexOf('LEAKq32'), -1);
    });

    it('03.3 - dollar-token refs to a bracket-named peer keep resolving (raw keys kept)', function () {
        var match = drive(
            { 'q33a[q33b]': { isRequired: true }, q33c: { isRequired: true, is: '$q33c === $q33a[q33b]' } },
            { 'q33a[q33b]': 'x', q33c: 'x' });
        var diff = drive(
            { 'q33d[q33e]': { isRequired: true }, q33f: { isRequired: true, is: '$q33f === $q33d[q33e]' } },
            { 'q33d[q33e]': 'x', q33f: 'y' });
        assert.equal(match.valid, true, 'matching cross-field ref must stay valid');
        assert.equal(diff.valid, false, 'mismatch must stay invalid — the pair proves the ref is LIVE');
        assert.deepEqual(diff.errs.q33f, ['is']);
    });

    it('03.4 - a flat rule addressing a parent OBJECT value is untouched', function () {
        var r = drive({ q34p: { isRequired: true } }, { q34p: { q34x: 'x' } });
        assert.equal(r.valid, true);
        assert.equal(r.data.q34p.q34x, 'x', 'the object value survives; the ruleless synthesized leaf changes nothing');
    });

    it('03.5 - a dollar-ref to a NESTED peer stays fail-closed (no accidental semantics change)', function () {
        var r = drive(
            { q35c: { isRequired: true, is: '$q35c === $q35p[q35x]' } },
            { q35p: { q35x: 'x' }, q35c: 'x' });
        assert.equal(r.valid, false, 'the parent-object splice keeps rejecting, exactly as before the fix');
        assert.deepEqual(r.errs.q35c, ['is']);
    });

    it('03.6 - the no-rules branch keeps the payload verbatim, raw keys untouched', function () {
        var res = Validator({}, { 'q36a[q36b]': 'v' }, 'bracket-rules-form');
        assert.equal(typeof res.toData, 'function', 'no-rules shape is the bare engine instance');
        assert.equal(res.toData()['q36a[q36b]'], 'v', 'no alias, no expansion, no drop');
    });

    it('03.7 - an EMPTY object the caller posted survives (nothing prunes what no exclusion emptied)', function () {
        var r = drive({ q37n: { isRequired: true } }, { q37n: 'ok', q37meta: {} });
        assert.equal(r.valid, true);
        assert.ok(r.data && typeof r.data.q37meta === 'object' && Object.keys(r.data.q37meta).length === 0,
            'the posted empty object is still there: ' + JSON.stringify(r.data));
    });

    it('03.8 - a caller that posts the DOTTED key keeps its own addressing (not an alias)', function () {
        var r = drive({ 'q38a[q38b]': { isRequired: true } }, { 'q38a.q38b': '' });
        assert.equal(r.valid, false, 'the dotted key joined the canon before the fix and still does');
        assert.deepEqual(r.errs['q38a.q38b'], ['isRequired'], 'error keyed by the key the caller posted');
    });
});

// ---------------------------------------------------------------------------
// §04 — dist fidelity (the plugin file is browser-bundled)
// ---------------------------------------------------------------------------
describe('validator-server-bracket-rules §04 — dist pins', function () {

    it('04.1 - the raw bundle carries the alias helpers', function () {
        var raw = fs.readFileSync(DIST_RAW_PATH, 'utf8');
        assert.ok(raw.indexOf('var backendAliasAugment = function (') > -1,
            'gina.js (unminified concat) must carry the augment helper');
    });

    it('04.2 - the minified bundle carries the alias meta shape', function () {
        var min = fs.readFileSync(DIST_MIN_PATH, 'utf8');
        // Closure SIMPLE keeps property names and string literals — the real
        // emission (derived from the actual artifact, 2026-08-04) writes the meta
        // with SINGLE quotes: {kind:'bracket',original:x} / {kind:'nested',...}.
        // \s* at the token boundary keeps the pin wrap-agnostic (a Closure line
        // wrap is content-dependent and moves across unrelated rebuilds).
        var needle = /kind:\s*'bracket'/;
        var control = /kind:\s*'nested'/;
        assert.match(min, needle, 'gina.min.js must carry the bracket alias meta');
        assert.match(min, control, 'and the nested alias meta');
    });
});
