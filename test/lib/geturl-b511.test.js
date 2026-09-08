'use strict';
/**
 * #B511 — a leading-`/` route never enters `getUrl`'s `rule@bundle` split
 * (swig and nunjucks filter twins).
 *
 * Both filters split any `@`-bearing route as `rule@bundle` BEFORE testing whether
 * it was a path, so `'/assets/img/common/header@2x.png' | getUrl` — the retina
 * idiom the filter's own comment cites — was cut into rule `/assets/img/common/header`
 * @ bundle `2x.png`, failed the bundle lookup and called `throwError(500)` mid-render
 * (measured live: HTTP 500, `todo/b511-harness/`). The guard adds one term: a route
 * starting with `/` is a path, never a rule reference, and skips the split.
 *
 * §01 pins both engines on the raw source (guarded form present, old form gone,
 * with the split statement and the path branch as anti-vacuity controls, and the
 * ORDER — guard before path branch — asserted, since the ordering IS the defect).
 * §02 lifts the shipped condition out of each engine's source into a pure predicate
 * (it references only `route` and `base`, so lifting captures no closure) and
 * drives it; the PRE-fix predicate is hand-written as the subtract control.
 */
var test   = require('node:test');
var assert = require('node:assert');
var fs     = require('fs');
var path   = require('path');

var FW = require('../fw');
var ENGINES = [
    [ 'swig',     fs.readFileSync(path.join(FW, 'lib/swig-filters/src/main.js'), 'utf8') ],
    [ 'nunjucks', fs.readFileSync(path.join(FW, 'lib/nunjucks-filters/src/main.js'), 'utf8') ]
];
var GUARDED = "if (!/^\\//.test(route) && /\\@/.test(route) && typeof(base) == 'undefined') {";
var OLD     = "if (/\\@/.test(route) && typeof(base) == 'undefined') {";
var SPLIT   = "var r = route.split(/\\@/);";
var ISPATH  = '// is path ?';
function count(hay, needle) { return hay.split(needle).length - 1; }

ENGINES.forEach(function (pair) {
    var name = pair[0], src = pair[1];
    test('#B511 §01 [' + name + '] the `@` split is guarded by the path test, the unguarded form is gone, and the guard precedes the path branch', function () {
        assert.strictEqual(count(src, GUARDED), 1, 'guarded split present once');
        assert.strictEqual(count(src, OLD), 0, 'unguarded split gone');
        assert.strictEqual(count(src, SPLIT), 1, 'the split statement is still there (anti-vacuity for the 0 above)');
        assert.strictEqual(count(src, ISPATH), 1, 'the later path branch is still there');
        assert.ok(src.indexOf(GUARDED) < src.indexOf(ISPATH), 'the split sits BEFORE the path branch — that ordering is why the guard is needed');
    });
});

/** The shipped condition, lifted verbatim from an engine's source into a pure predicate. */
function shippedPredicate(src) {
    var i = src.indexOf(GUARDED);
    assert.ok(i > -1, 'guarded condition found');
    var cond = GUARDED.slice('if ('.length, -') {'.length);
    return new Function('route', 'base', 'return ' + cond + ';'); // references only its two params
}
/** The PRE-fix decision — the subtract control. */
function preFixPredicate(route, base) { return /\@/.test(route) && typeof(base) == 'undefined'; }

var RETINA = '/assets/img/common/header@2x.png';

ENGINES.forEach(function (pair) {
    var name = pair[0], splits = shippedPredicate(pair[1]);
    test('#B511 §02 [' + name + '] the retina path no longer splits; a rule@bundle reference still does; a passed base still wins', function () {
        assert.strictEqual(splits(RETINA, undefined), false, 'path with @ — no split');
        assert.strictEqual(splits('/assets/img/x.png', undefined), false, 'plain path — no split');
        assert.strictEqual(splits('home@web', undefined), true, 'rule@bundle — still splits (unchanged contract)');
        assert.strictEqual(splits('home', undefined), false, 'bare rule — no split');
        assert.strictEqual(splits(RETINA, 'public'), false, 'a passed base never splits');
        assert.strictEqual(splits('home@web', 'public'), false, 'a passed base wins over the in-string form');
    });
});

test('#B511 §02b subtract control: the PRE-fix decision DID split the retina path (the defect is detectable by this instrument)', function () {
    assert.strictEqual(preFixPredicate(RETINA, undefined), true);
    assert.strictEqual(preFixPredicate('home@web', undefined), true);
    assert.strictEqual(preFixPredicate('/assets/img/x.png', undefined), false, 'the pre-fix form was fine WITHOUT an @ — the guard changes only the @-bearing path case');
});
