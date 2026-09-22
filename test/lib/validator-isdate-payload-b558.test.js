'use strict';
/**
 * #B558 — `isDate` wrote a `Date` OBJECT into the submitted payload, so every
 * client east of UTC submitted the PREVIOUS day.
 *
 * Mechanism: the valid path built a LOCAL-midnight date
 * (`new Date(yNum, moNum - 1, dNum)`) and then fused two assignments —
 * `this.value = local.data[this.name] = date`. `local.data` is the submitted
 * payload; it is JSON-stringified before submit, and `JSON.stringify` renders a
 * `Date` via `toISOString()`. That yields a UTC INSTANT whose DATE PART is one
 * day earlier for every positive UTC offset: Europe/Paris `2026-09-18` went on
 * the wire as `2026-09-17T22:00:00.000Z`. Silent, because the instant is
 * well-formed — only a reader that slices the date part ever saw it.
 *
 * Why a `Date` at all: EVERY validator normalises the payload to the validated
 * canonical form (`isEmail` lowercases, `isBoolean` -> boolean, `isNumber` ->
 * Number), so `isDate` normalising is CONSISTENT with its siblings, and
 * "validate, don't mutate" would have made it the sole non-normalising rule.
 * The real defect is narrower: `Date` is the only normalised type that does not
 * round-trip through JSON — a calendar date is not an instant.
 *
 * Corroborated twice by gina contradicting itself: `requirementToSchema` emits
 * `{type:'string', format:'date'}` for an isDate field, and `dto.date()` emits
 * `a?: string` + `@format date` (locked by `dto-types.test.js` 02.4). Both are
 * RFC 3339 full-date, explicitly NOT date-time.
 *
 * Fix: split the fused assignment. `this.value = date` (the FIELD keeps the
 * Date, so `.format()` and the #B48 chaining contract are untouched) and
 * `local.data[this.name]` takes `yyyy-mm-dd`, ALWAYS — the mask governs INPUT
 * parsing, the published schema is mask-independent. The components are read
 * back with the Date's LOCAL getters, which the rule's own round-trip check has
 * already proven equal to the parsed input, so no timezone enters the value.
 *
 * DISCLOSED BREAKING SURFACE: the wire shape changes for every form carrying
 * `isDate`, and server-side `req.body.<field>` stops being a `Date`.
 *
 * WHY THE FIRST THREE HARNESSES WERE STUCK (pinned by 00.2/00.3): the engine
 * does `local.data = merge(JSON.clone(data), local.data)` at construction, so
 * the payload is a CLONE of the object handed in. A harness that inspects its
 * OWN INPUT object can never observe the write-back and prints the untouched
 * input for fixed and pre-fix code alike. `toData()` returns `local.data`
 * itself and is the valid observation point.
 *
 * Red-first buckets, measured on pre-fix bytes (HEAD f7ae4a0b1):
 *   MUST-RED   — 01.* (all seven), 04.1, 04.2, 04.3, 05.1, 05.2.  (04.3 is red
 *                because the `// was:` record is itself part of the fix.)
 *   MUST-GREEN — 00.* (instrument), 02.* (#B48 non-regression), 03.* (controls),
 *                04.4 (the slicer control).
 * At the src-fixed/dist-stale midstate only 05.* stays red — the free subtract
 * proving the dist pins watch the artifact, not the source.
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
setContext('bundle', 'isdatepayloadbundle');

var ENGINE_PATH = path.join(FW, 'core/plugins/lib/validator/src/form-validator.js');
var ENGINE_SRC = fs.readFileSync(ENGINE_PATH, 'utf8');
var DIST_RAW_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN_PATH = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var FormValidator = require(ENGINE_PATH);

var HOST_TZ = process.env.TZ;

/** Comment-stripped view — negative pins must not match a `// was:` record. */
function activeLines(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/** Engine rule-body slicer (template: validator-isboolean-contract.test.js). */
function bodyOf(rule) {
    var start = ENGINE_SRC.indexOf("self[el]['" + rule + "'] = function");
    assert.ok(start > -1, 'rule `' + rule + '` not found');
    var next = ENGINE_SRC.indexOf('self[el][', start + 10);
    assert.ok(next > start, 'no following rule definition');
    return ENGINE_SRC.substring(start, next);
}

/**
 * Drive the shipped engine under a named timezone and report what the NETWORK
 * would carry. The observation point is `toData()` (i.e. `local.data`), never
 * the input object — see 00.2/00.3.
 */
function driveIn(tz, value, mask, useIsDate) {
    var previous = process.env.TZ;
    process.env.TZ = tz;
    try {
        var input = { myDate: value };
        var v = new FormValidator(input, undefined, undefined, undefined, undefined);
        var chained = null;
        if (useIsDate !== false) {
            chained = (mask === undefined) ? v.myDate.isDate() : v.myDate.isDate(mask);
        }
        var payload = v.toData();
        var field = v.myDate.value;
        // Every derived reading is taken INSIDE the timezone window. A `Date`
        // read back after the window closes is reinterpreted against the
        // restored zone, so `getDate()` and `format()` would report the host's
        // calendar day, not the submitter's -- measured: this host is
        // Africa/Douala (UTC+1), and reading a Paris-midnight Date here yielded
        // 2026-09-17T23:00:00. That is an artifact of the harness, never of the
        // engine, and it is exactly the class of instrument error #B558's three
        // stuck harnesses died of.
        return {
            input: input,
            payload: payload,
            wire: JSON.parse(JSON.stringify(payload)).myDate,
            payloadValue: payload.myDate,
            payloadIsString: (typeof payload.myDate === 'string'),
            payloadIsDate: (payload.myDate instanceof Date),
            fieldIsDate: (field instanceof Date),
            fieldY: (field instanceof Date && !isNaN(field.getTime())) ? field.getFullYear() : null,
            fieldM: (field instanceof Date && !isNaN(field.getTime())) ? field.getMonth() : null,
            fieldD: (field instanceof Date && !isNaN(field.getTime())) ? field.getDate() : null,
            chainedHasFormat: !!(chained && typeof chained.format === 'function'),
            chainedFormatted: (chained && typeof chained.format === 'function')
                ? (function () { try { return chained.format('isoDateTime'); } catch (e) { return 'THREW: ' + e.message; } })()
                : null,
            valid: v.myDate.valid
        };
    } finally {
        if (previous === undefined) { delete process.env.TZ; } else { process.env.TZ = previous; }
    }
}

/** Positive offsets shift the date part back a day; the negative one must not. */
var EAST_ZONES = ['Europe/Paris', 'Africa/Douala', 'Pacific/Auckland'];

// ---------------------------------------------------------------------------
// 00 — instrument validation. These arms exist so the suite CANNOT pass
//      vacuously: they prove the timezone lever actually moves, and that the
//      observation point is the one the three stuck harnesses missed.
// ---------------------------------------------------------------------------
describe('validator-isdate-payload-b558 00 - instrument validation', function () {

    it('00.1 - the in-process TZ lever really moves the clock', function () {
        function isoOf(tz) {
            var previous = process.env.TZ;
            process.env.TZ = tz;
            try { return new Date(2026, 8, 18).toISOString(); }
            finally { if (previous === undefined) { delete process.env.TZ; } else { process.env.TZ = previous; } }
        }
        assert.equal(isoOf('UTC'), '2026-09-18T00:00:00.000Z', 'UTC midnight is the reference');
        assert.equal(isoOf('Europe/Paris'), '2026-09-17T22:00:00.000Z',
            'if this fails the runtime stopped honouring a mid-process TZ change and EVERY timezone arm below is vacuous');
        assert.notEqual(isoOf('Pacific/Auckland'), isoOf('UTC'), 'the lever must discriminate between zones');
    });

    it('00.2 - the payload is a CLONE: the input object is NOT the observation point', function () {
        var r = driveIn('Europe/Paris', '2026-09-18', undefined, true);
        assert.notEqual(r.payload, r.input,
            'local.data = merge(JSON.clone(data), local.data) — a harness that reads its own input can never see the write-back');
        assert.equal(r.input.myDate, '2026-09-18',
            'the caller-supplied object stays untouched in BOTH engines; this is exactly why three harnesses read the same value pre- and post-fix');
    });

    it('00.3 - toData() is a live view of the payload the rule wrote', function () {
        var r = driveIn('Europe/Paris', '2026-09-18', undefined, true);
        assert.ok(Object.prototype.hasOwnProperty.call(r.payload, 'myDate'), 'the field must be present in the payload');
        assert.notEqual(r.payloadValue, undefined, 'the observation point must actually carry the written value');
    });

    it('00.4 - the host clock is restored after every drive', function () {
        function hostIso() { return new Date(2026, 8, 18).toISOString(); }
        var before = hostIso();
        driveIn('Pacific/Auckland', '2026-09-18', undefined, true);
        assert.equal(process.env.TZ, HOST_TZ, 'a leaked TZ env var would poison every later test file in the run');
        assert.equal(hostIso(), before,
            'the env var alone is not the instrument -- assert the clock itself, or a restore that silently failed would still read as clean');
    });
});

// ---------------------------------------------------------------------------
// 01 — the defect: what the network carries
// ---------------------------------------------------------------------------
describe('validator-isdate-payload-b558 01 - the submitted payload is a date-only string', function () {

    EAST_ZONES.forEach(function (tz, i) {
        it('01.' + (i + 1) + ' - ' + tz + ' submits the day the user picked', function () {
            var r = driveIn(tz, '2026-09-18', undefined, true);
            assert.equal(r.valid, true, 'the date is valid; this arm is about the payload, not the verdict');
            assert.equal(r.wire, '2026-09-18',
                'east of UTC the fused assignment put a Date on the wire, and toISOString() rendered the PREVIOUS day');
        });
    });

    it('01.4 - the wire value is identical in every timezone', function () {
        var seen = ['UTC'].concat(EAST_ZONES).concat(['America/New_York']).map(function (tz) {
            return driveIn(tz, '2026-09-18', undefined, true).wire;
        });
        assert.deepEqual(seen, ['2026-09-18', '2026-09-18', '2026-09-18', '2026-09-18', '2026-09-18'],
            'a calendar date must not depend on the submitter location');
    });

    it('01.5 - the payload value is a STRING, not a Date (the disclosed breaking change)', function () {
        var r = driveIn('Europe/Paris', '2026-09-18', undefined, true);
        assert.equal(r.payloadIsString, true, 'server-side req.body.<field> is no longer a Date');
        assert.equal(r.payloadIsDate, false);
    });

    it('01.6 - single-digit month and day are zero-padded', function () {
        assert.equal(driveIn('Europe/Paris', '2026-01-05', undefined, true).wire, '2026-01-05',
            'RFC 3339 full-date is fixed-width; `2026-1-5` is not a valid `format: date`');
    });

    it('01.7 - the shape is mask-independent', function () {
        assert.equal(driveIn('Europe/Paris', '18/09/2026', 'dd/mm/yyyy', true).wire, '2026-09-18',
            'the mask governs INPUT parsing; the published schema is {type:string, format:date} regardless');
        assert.equal(driveIn('Europe/Paris', '18-09-2026', 'dd-mm-yyyy', true).wire, '2026-09-18');
    });
});

// ---------------------------------------------------------------------------
// 02 — #B48 non-regression: the FIELD still carries the Date
// ---------------------------------------------------------------------------
describe('validator-isdate-payload-b558 02 - the #B48 chaining contract is intact', function () {

    it('02.1 - the field value stays a Date', function () {
        var r = driveIn('Europe/Paris', '2026-09-18', undefined, true);
        assert.equal(r.fieldIsDate, true, 'the fix must split the assignment, not move it');
        assert.deepEqual([r.fieldY, r.fieldM, r.fieldD], [2026, 8, 18],
            'read inside the submitter timezone, the field still carries the picked calendar day');
    });

    it('02.2 - isDate() still returns the chainable field object', function () {
        var r = driveIn('Europe/Paris', '2026-09-18', undefined, true);
        assert.equal(r.chainedHasFormat, true, '#B48 returns the field, not the raw Date');
    });

    it('02.3 - the documented idiom field.isDate(mask).format() still renders the picked day', function () {
        var r = driveIn('Europe/Paris', '2026-09-18', undefined, true);
        assert.equal(r.chainedFormatted, '2026-09-18T00:00:00',
            'the #B48 comment promises this idiom keeps working; it reads this.value, which the fix leaves alone');
    });
});

// ---------------------------------------------------------------------------
// 03 — controls. Each of these reads the SAME on pre-fix and fixed bytes, so a
//      stuck instrument shows up here as a false difference.
// ---------------------------------------------------------------------------
describe('validator-isdate-payload-b558 03 - controls', function () {

    it('03.1 - a field with no isDate rule is left exactly as supplied', function () {
        var r = driveIn('Europe/Paris', '2026-09-18', undefined, false);
        assert.equal(r.wire, '2026-09-18');
        assert.equal(r.payloadIsString, true, 'no rule ran, so nothing normalised it');
    });

    it('03.2 - an out-of-range date still rejects, and its payload is untouched by the fix', function () {
        var r = driveIn('Europe/Paris', '2026-02-30', undefined, true);
        assert.equal(r.valid, false, 'the #B47 round-trip check still rejects rolled-over components');
        assert.equal(r.wire, null, 'the error path keeps the Invalid Date object, which JSON renders as null');
    });

    it('03.3 - west of UTC the date part was never wrong, and still is not', function () {
        var r = driveIn('America/New_York', '2026-09-18', undefined, true);
        assert.equal(String(r.wire).slice(0, 10), '2026-09-18',
            'a negative offset pushes the instant LATER, so the date part survived even pre-fix; this reads the same on both engines and localises the defect to positive offsets');
        assert.equal(r.valid, true);
    });

    it('03.4 - a sibling normalising rule is unaffected', function () {
        var previous = process.env.TZ;
        process.env.TZ = 'Europe/Paris';
        try {
            var v = new FormValidator({ mail: 'User@Example.COM' }, undefined, undefined, undefined, undefined);
            v.mail.isEmail();
            assert.equal(v.toData().mail, 'user@example.com',
                'isDate is consistent with its siblings: every validator normalises the payload');
        } finally {
            if (previous === undefined) { delete process.env.TZ; } else { process.env.TZ = previous; }
        }
    });
});

// ---------------------------------------------------------------------------
// 04 — source pins
// ---------------------------------------------------------------------------
describe('validator-isdate-payload-b558 04 - engine source pins', function () {

    it('04.1 - the fused assignment is gone from active lines', function () {
        var active = activeLines(bodyOf('isDate'));
        assert.equal(active.indexOf('this.value = local.data[this.name] = date;'), -1,
            'the payload must not be written the same object the field keeps');
    });

    it('04.2 - the payload takes a composed yyyy-mm-dd string', function () {
        var active = activeLines(bodyOf('isDate'));
        assert.match(active, /local\.data\[this\.name\]\s*=\s*date\.getFullYear\(\)/,
            'built from the Date LOCAL getters, which the round-trip check already proved equal to the input');
        assert.match(active, /\('0' \+ \(date\.getMonth\(\) \+ 1\)\)\.slice\(-2\)/, 'zero-padded month');
        assert.match(active, /\('0' \+ date\.getDate\(\)\)\.slice\(-2\)/, 'zero-padded day');
        assert.match(active, /this\.value = date;/, 'the field keeps the Date (#B48)');
    });

    it('04.3 - control: the replaced line survives as a `// was:` record', function () {
        var body = bodyOf('isDate');
        assert.ok(body.indexOf('// was: this.value = local.data[this.name] = date;') > -1,
            'the comment-stripped view in 04.1 must be discriminating, not merely empty');
        assert.ok(bodyOf('isDate').indexOf('#B558') > -1, 'the site carries its own reason');
    });

    it('04.4 - control: the slicer can fail', function () {
        assert.throws(function () { bodyOf('noSuchRule'); }, /not found/);
    });
});

// ---------------------------------------------------------------------------
// 05 — dist fidelity (red until the prod rebuild). form-validator.js is
//      browser-bundled, so pickup is RESTART *and* RE-BAKE.
// ---------------------------------------------------------------------------
describe('validator-isdate-payload-b558 05 - dist fidelity', function () {

    it('05.1 - gina.js carries the split assignment', function () {
        var active = activeLines(fs.readFileSync(DIST_RAW_PATH, 'utf8'));
        assert.ok(active.indexOf("local.data[this.name] = date.getFullYear()") > -1,
            'the composed date-only string must reach the bundle');
        assert.equal(active.indexOf('this.value = local.data[this.name] = date;'), -1,
            'the fused assignment must not survive in executable dist bytes');
    });

    it('05.2 - gina.min.js: the served artifact composes the date-only string', function () {
        var min = fs.readFileSync(DIST_MIN_PATH, 'utf8');
        // Derived from the REAL Closure emission at the rebuild, never from a
        // guessed shape -- the first draft of this pin assumed double quotes and
        // did not match. Closure renames `date` (to `Q` at this build) but keeps
        // the getter chain, the operand order and SINGLE quotes:
        //   <v>.getFullYear()+'-'+('0'+(<v>.getMonth()+1)).slice(-2)+'-'+('0'+<v>.getDate()).slice(-2)
        // Identifier-agnostic via the backreference, quote-agnostic and
        // wrap-agnostic (per the content-dependent line-wrap lesson), so a
        // rename or a requoting on a later build cannot false-negative it.
        // Validated 0-pre / 1-post against the actual artifacts.
        var m = min.match(/([A-Za-z_$][\w$]*)\.getFullYear\(\)\s*\+\s*['"]-['"]\s*\+\s*\(['"]0['"]\s*\+\s*\(\1\.getMonth\(\)\s*\+\s*1\)\)\.slice\(-2\)\s*\+\s*['"]-['"]\s*\+\s*\(['"]0['"]\s*\+\s*\1\.getDate\(\)\)\.slice\(-2\)/);
        assert.ok(m, 'gina.min.js is what browsers run — the composed date-only payload must reach it');
    });
});
