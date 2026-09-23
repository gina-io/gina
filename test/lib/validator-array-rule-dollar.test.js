'use strict';
/**
 * #B239 — a `$` token in an ARRAY rule's FIRST argument that names no field
 * crashed the whole validation pass, on BOTH paths (client and server).
 *
 * `checkFieldAgainstRules` handles array-form rules (`isInList: [...]`) by
 * scanning args[0] with the token matcher (a `$` followed by word characters,
 * hyphens or square brackets) and replacing each match with the referenced
 * field's value — dereferencing `d[<token minus the sigil>].value` blind,
 * where `d` is the FormValidator field map. A token that resolves to NO field
 * (`'$100'`, a bare `'$'`, a mixed literal) threw
 * `TypeError: Cannot read properties of undefined`; a token that collides
 * with an ENGINE METHOD name (`'$isValid'`, `'$constructor'`) resolved to the
 * method — whose `.value` is undefined — so String.replace spliced the string
 * "undefined" into the rule and produced a silently WRONG verdict instead of
 * a crash.
 *
 * Fix: a two-clause guard — substitution happens ONLY when the token resolves
 * to a real field (the key exists AND carries a defined `.value`); everything
 * else stays LITERAL, so strict comparison applies (`'$100'` matches the list
 * element `'$100'`, rejects `'999'` with the rule's own error). Both clauses
 * are load-bearing: the first covers unknown names, the second covers
 * method-name collisions (measured: `d['isValid']` is defined on both
 * constructor shapes with `.value` undefined).
 *
 * SCOPE — what this fix does NOT cover (measured pre-vs-post on the real
 * bytes, patched copies): a REAL cross-field reference inside an array rule
 * (`isInList: ['$peer', ...]`) is substituted UPSTREAM by getDynamisedRules
 * loop 1, which wraps the value in escaped quotes — correct for splicing into
 * a stringified `is` CONDITION, wrong for an array element, so the comparison
 * can never match (always-invalid, fail-closed). That is #B240, tracked
 * separately; §03 pins it as a characterization so any semantics change is
 * loud. This guard deliberately PRESERVES the substitution path for real
 * fields — the natural substrate if #B240 ever relocates array-element
 * substitution here (context-precise, raw values).
 *
 * Red-first buckets (pre-fix bytes):
 *   MUST-RED  — §01.2/§01.3 (the guard is absent / the blind deref is live),
 *               §02.1-§02.5 (crash arms + the method-collision arm),
 *               §04 (dist pins, red until the prod rebuild).
 *   MUST-GREEN (premises/controls) — §01.1/§01.4/§01.5, all of §03.
 * At the src-fixed/dist-stale midstate only §04 stays red.
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
setContext('bundle', 'arraydollarbundle');

var MAIN_PATH = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var MAIN_SRC = fs.readFileSync(MAIN_PATH, 'utf8');
var DIST_RAW_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var Validator = require(MAIN_PATH);

/** checkFieldAgainstRules slicer — declaration to the FormValidator-instance decl that follows it. */
function cfarBlock(src) {
    var start = src.indexOf('var checkFieldAgainstRules = function(');
    var end = src.indexOf('var d = null;//FormValidator instance', start);
    assert.ok(start > -1 && end > start, 'checkFieldAgainstRules block not found');
    return src.slice(start, end);
}

/** Comment-stripped view — the `// was:` record must not satisfy code pins. */
function activeLines(block) {
    return block.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

function drivePlugin(rules, data) {
    var res = Validator(JSON.parse(JSON.stringify(rules)), JSON.parse(JSON.stringify(data)), 'array-dollar-form');
    var errs = {};
    for (var f in res.error || {}) { errs[f] = Object.keys(res.error[f] || {}); }
    return { formValid: res.isValid(), errs: errs, data: res.data };
}

// ---------------------------------------------------------------------------
// §01 — source pins on the substitution guard
// ---------------------------------------------------------------------------
describe('validator-array-rule-dollar §01 — source pins', function () {

    it('01.1 - control: the slicer can fail', function () {
        assert.throws(function () { cfarBlock('nothing here'); }, /not found/);
        assert.ok(cfarBlock(MAIN_SRC).length > 400, 'real block sliced');
    });

    it('01.2 - the two-clause guard gates the substitution (whole expression, terminator-anchored)', function () {
        var block = cfarBlock(MAIN_SRC);
        // Anchored over the FULL condition through `) {` + the skip, so a
        // right-extension (a third clause) or a body change breaks the pin.
        assert.match(block,
            /typeof\(d\[_refName\]\) == 'undefined'\s*\|\|\s*typeof\(d\[_refName\]\.value\) == 'undefined'\s*\)\s*\{\s*continue;/,
            'substitution must be skipped unless the token resolves to a real field (defined .value)');
        // ...and the substitution itself reads through the SAME resolved name.
        assert.ok(block.indexOf('args[0] = args[0].replace( foundVariables[v], d[_refName].value );') > -1,
            'the guarded substitution must use the resolved field value');
    });

    it('01.3 - the blind deref no longer EXECUTES (survives only as the was: record)', function () {
        var block = cfarBlock(MAIN_SRC);
        var OLD = "d[foundVariables[v].replace('$', '')].value";
        assert.ok(activeLines(block).indexOf(OLD) < 0,
            'the unguarded deref must not survive as active code');
        // positive control: the replace-code convention keeps the old line as a
        // comment — proving activeLines() is reading a stripped view rather than
        // an empty string (a negative pin needs a can-fire control).
        assert.ok(block.indexOf(OLD) > -1,
            'the was: record must still carry the old line');
    });

    it('01.4 - premise: the array-rule branch and its args[0]-only scan are unchanged', function () {
        var block = cfarBlock(MAIN_SRC);
        assert.ok(block.indexOf('if (Array.isArray(rules[field][rule])) { // has args') > -1);
        assert.ok(block.indexOf('/\\$[\\-\\w\\[\\]]*/.test(args[0])') > -1,
            'only args[0] is scanned — a later element is never substituted');
        assert.ok(block.indexOf('args[0].match(/\\$[\\-\\w\\[\\]]*/g)') > -1);
    });

    it('01.5 - premise: the upstream dynamised-mode quoting still wraps the value (#B240 is NOT fixed here)', function () {
        // getCastedValue's dynamised return wraps in escaped quotes — correct for
        // `is` condition splices, and the mechanism behind #B240 for array elements.
        // #B600 escaped the value INSIDE those quotes (a `"` or `\` in it broke the
        // closing parse); the quotes themselves stay, so #B240's premise holds and
        // its behaviour stays locked by 03.3/03.4. Pinned on comment-stripped
        // source: the replace-code record must not be able to satisfy it.
        var active = activeLines(MAIN_SRC);
        assert.match(active,
            /return isOnDynamisedRules \? quoteForDynamisedRules\(fields\[fieldName\]\) : fields\[fieldName\];/,
            'the quoting tail must still wrap the value — changing its quoting is #B240 scope');
        assert.match(active,
            /return '\\\\"' \+ escapeForJsonString\(escapeForJsonString\(value\)\) \+ '\\\\"';/,
            'quoteForDynamisedRules wraps the escaped value in escaped quotes');
    });
});

// ---------------------------------------------------------------------------
// §02 — behaviour: the healed arms (all MUST-RED on pre-fix bytes)
// ---------------------------------------------------------------------------
describe('validator-array-rule-dollar §02 — healed arms', function () {

    it('02.1 - a non-field `$` token in args[0] validates its literal (was: TypeError)', function () {
        var r;
        assert.doesNotThrow(function () {
            r = drivePlugin({ amount: { isRequired: true, isInList: ['$100', '$200'] } },
                { amount: '$100' });
        });
        assert.equal(r.formValid, true, "the literal '$100' is in the list");
        assert.deepEqual(r.errs, {});
    });

    it('02.2 - the same rule REJECTS a non-member with its own error (verdicts live, was: TypeError)', function () {
        var r = drivePlugin({ amount: { isRequired: true, isInList: ['$100', '$200'] } },
            { amount: '999' });
        assert.equal(r.formValid, false);
        assert.deepEqual(r.errs.amount, ['isInList']);
    });

    it('02.3 - a bare `$` element validates its literal (was: TypeError on the empty-name deref)', function () {
        var r;
        assert.doesNotThrow(function () {
            r = drivePlugin({ amount: { isRequired: true, isInList: ['$', 'x'] } },
                { amount: '$' });
        });
        assert.equal(r.formValid, true);
    });

    it('02.4 - a token colliding with an ENGINE METHOD name stays literal (was: silent WRONG verdict, not a crash)', function () {
        // Pre-fix this arm did NOT throw: d['isValid'] resolves to the engine
        // method, whose .value is undefined, so the string "undefined" was
        // spliced into the rule and the literal value wrongly failed the list.
        // The second guard clause is what heals this class.
        var r = drivePlugin({ amount: { isRequired: true, isInList: ['$isValid', 'x'] } },
            { amount: '$isValid' });
        assert.equal(r.formValid, true, "the literal '$isValid' is in the list");
        assert.deepEqual(r.errs, {});
    });

    it('02.5 - a mixed element (field token + non-field residue) no longer throws', function () {
        // Loop 1 substitutes the KNOWN field token upstream (quoted, per #B240);
        // the non-field residue then reaches args[0] and used to crash here.
        var r;
        assert.doesNotThrow(function () {
            r = drivePlugin({
                status: { isRequired: true },
                amount: { isRequired: true, isInList: ['$status-$100', 'x'] }
            }, { status: 'approved', amount: 'anything' });
        });
        assert.equal(r.formValid, false, 'nothing matches the composite element');
        assert.deepEqual(r.errs.amount, ['isInList']);
    });
});

// ---------------------------------------------------------------------------
// §03 — controls and characterizations (all MUST-GREEN on pre- AND post-fix bytes)
// ---------------------------------------------------------------------------
describe('validator-array-rule-dollar §03 — controls', function () {

    it('03.1 - a `$` in a LATER array element is clean (only args[0] is scanned)', function () {
        var r = drivePlugin({ amount: { isRequired: true, isInList: ['100', '$200'] } },
            { amount: '100' });
        assert.equal(r.formValid, true);
    });

    it('03.2 - $-free array rules are untouched, both directions', function () {
        var ok = drivePlugin({ amount: { isRequired: true, isInList: ['100', '200'] } },
            { amount: '100' });
        assert.equal(ok.formValid, true);
        var ko = drivePlugin({ amount: { isRequired: true, isInList: ['100', '200'] } },
            { amount: '999' });
        assert.equal(ko.formValid, false);
        assert.deepEqual(ko.errs.amount, ['isInList']);
    });

    it('03.3 - CHARACTERIZATION #B240: a real cross-field ref in an array rule is always-invalid (quoted upstream)', function () {
        // getDynamisedRules loop 1 replaces `$peer` with the QUOTED value, so the
        // engine compares `yes` against `"yes"` (quotes included) — never a match.
        // KNOWN limitation, fail-closed, tracked as #B240. If this arm ever reads
        // valid=true, the loop-1 quoting semantics changed — re-read #B240 before
        // touching this pin.
        var r = drivePlugin({
            peer: { isRequired: true },
            amount: { isRequired: true, isInList: ['$peer', 'other'] }
        }, { peer: 'yes', amount: 'yes' });
        assert.equal(r.formValid, false);
        assert.deepEqual(r.errs.amount, ['isInList']);
    });

    it('03.4 - CHARACTERIZATION #B240 (collision shape): an element naming a sibling field is reinterpreted, not literal', function () {
        // The author's literal '$status' is consumed upstream as a REFERENCE
        // (substituted + quoted), so the literal token can never match — the
        // reserved-sigil hazard the lib/dto toRules `$` guard protects DTO
        // authoring from (see test/lib/dto.test.js §09).
        var r = drivePlugin({
            status: { isRequired: true },
            amount: { isRequired: true, isInList: ['$status', 'x'] }
        }, { status: 'approved', amount: '$status' });
        assert.equal(r.formValid, false);
        assert.deepEqual(r.errs.amount, ['isInList']);
    });

    it('03.5 - control: the same collision rules still accept a plain literal member', function () {
        var r = drivePlugin({
            status: { isRequired: true },
            amount: { isRequired: true, isInList: ['$status', 'x'] }
        }, { status: 'approved', amount: 'x' });
        assert.equal(r.formValid, true, 'verdicts are live on the collision shape too');
    });

    it('03.6 - control: cross-field `$` in an `is` CONDITION keeps working (the documented feature)', function () {
        var ok = drivePlugin({
            peer: { isRequired: true },
            amount: { isRequired: true, is: '$peer === $amount' }
        }, { peer: 'yes', amount: 'yes' });
        assert.equal(ok.formValid, true);
        var ko = drivePlugin({
            peer: { isRequired: true },
            amount: { isRequired: true, is: '$peer === $amount' }
        }, { peer: 'yes', amount: 'nope' });
        assert.equal(ko.formValid, false);
        assert.deepEqual(ko.errs.amount, ['is']);
    });
});

// ---------------------------------------------------------------------------
// §04 — dist fidelity (red until the prod rebuild)
// ---------------------------------------------------------------------------
describe('validator-array-rule-dollar §04 — dist fidelity', function () {

    it('04.1 - gina.js carries the two-clause guard verbatim', function () {
        var raw = fs.readFileSync(DIST_RAW_PATH, 'utf8');
        assert.match(raw,
            /typeof\(d\[_refName\]\) == 'undefined'\s*\|\|\s*typeof\(d\[_refName\]\.value\) == 'undefined'/,
            'the guard must reach the unminified bundle');
    });

    it('04.2 - gina.min.js: the guard reaches the served artifact', function () {
        var min = fs.readFileSync(DIST_MIN_PATH, 'utf8');
        // DERIVED from the REAL Closure emission at the rebuild — the compiler
        // De-Morgans `if (A || B) continue; subst` into `!A && !B && (subst)`:
        //   var La=vb[Ma].replace('$','');typeof Wa[La]!='undefined'&&
        //   typeof Wa[La].value!='undefined'&&(...)
        // — and validated 0-pre/1-post against the actual artifacts. The bare
        // typeof-chain alone is NOT unique (two pre-existing copy-if-absent
        // shapes elsewhere in the bundle match it — measured on the pre-fix
        // artifact, which is why the sigil-strip assignment is part of the
        // needle: only this site strips a leading `$` into the key local).
        // Backreferences bind the SAME key/map identifiers across the strip and
        // both conjuncts, so the pin is identifier-agnostic (Closure renames
        // freely per build) yet still discriminating; \s* at every token
        // boundary keeps it wrap-agnostic (the compiler line-breaks at
        // positions that shift with unrelated upstream edits).
        var m = min.match(
            /([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\[[A-Za-z_$][\w$]*\]\s*\.\s*replace\s*\(\s*'\$'\s*,\s*''\s*\)\s*;\s*typeof\s+([A-Za-z_$][\w$]*)\[\1\]\s*!=\s*'undefined'\s*&&\s*typeof\s+\2\[\1\]\s*\.\s*value\s*!=\s*'undefined'\s*&&/g
        ) || [];
        assert.equal(m.length, 1,
            'gina.min.js must carry the two-clause guard at exactly the one substitution site');
    });
});
