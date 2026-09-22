'use strict';
/**
 * #B555 — the boot-time guard that a declared entity actually reached its model.
 *
 * Attaching an entity to its model is a SIDE EFFECT of constructing it: only
 * `core/model/entity.js`'s `setListeners()` calls `modelUtil.updateModel()`, and
 * the entity registry's singleton short-circuit skips it. Before #B555 that
 * short-circuit fired whenever two connectors of one bundle declared an entity
 * class of the same name — guaranteed when they share a `database`, and equally
 * reachable across two databases that each carry a `user.js` — and the model
 * walked SECOND by the attach loop was left with a bare
 * `{ _connection, getConnection }`. The bundle then listened and SERVED; every
 * call on the missing entity failed at request time instead. `lib/model.js`
 * step 2 now names the unattached classes and aborts the boot.
 *
 * Why this file executes EXTRACTED source rather than driving the boot:
 * `loadAllModels` is not unit-isolatable — `test/lib/model-load.test.js:11-12`
 * and `test/core/model-no-connector.test.js:15-16` both say so in their own
 * headers, and no test in this repo boots it in-process. The decision logic was
 * therefore put in two PURE module-level functions so it can be executed as
 * shipped bytes, with the irreducible action (emerg + flush + exit) left as
 * three pinned lines. A replica cannot drift if there is no replica.
 *
 * Arms:
 *   §00 instrument validation — each extraction matches EXACTLY once and is
 *                               brace-balanced; a bogus name must not extract
 *   §01 source pins           — the guard is wired into step 2, retains the
 *                               instances, and fails fast the #B57 way
 *   §02 _unattachedEntities   — real bytes: healthy, one missing, all missing,
 *                               the `hasOwnEvents` opt-out, and an absent model
 *   §03 _expectedEntityKey    — real bytes: the camel + `Entity` suffix rule
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SOURCE = path.join(FW, 'lib/model.js');
var src    = fs.readFileSync(SOURCE, 'utf8');

/**
 * Extract `var <name> = function(...) { ... };` from the source by brace-matching,
 * so a multi-line body is captured whole (a line-bounded regex cannot).
 *
 * @inner
 * @param {string} source - the file text
 * @param {string} name   - the declared function name
 * @returns {{text: string, balanced: boolean, unique: boolean}}
 */
function extractFn(source, name) {
    var decl = 'var ' + name + ' = function(';
    var i = source.indexOf(decl);
    if (i < 0) { return { text: null, balanced: false, unique: false }; }
    var unique = source.indexOf(decl, i + 1) === -1;
    var open = source.indexOf('{', i);
    var depth = 0, j = open;
    for (; j < source.length; j++) {
        if (source[j] === '{') { depth++; }
        else if (source[j] === '}') { depth--; if (depth === 0) { break; } }
    }
    return { text: source.slice(i + ('var ' + name + ' = ').length, j + 1), balanced: depth === 0, unique: unique };
}

var EXP = extractFn(src, '_expectedEntityKey');
var UNA = extractFn(src, '_unattachedEntities');

/** The shipped `_expectedEntityKey`, executed as real bytes. @type {function} */
var expectedEntityKey = EXP.text ? new Function('return (' + EXP.text + ');')() : null;
/** The shipped `_unattachedEntities`, with its one dependency injected. @type {function} */
var unattachedEntities = UNA.text
    ? new Function('_expectedEntityKey', 'return (' + UNA.text + ');')(expectedEntityKey)
    : null;

/** @inner @returns {function} a stand-in entity constructor */
function ctor() { return function Entity() {}; }


describe('#B555 §00 - instrument validation', function () {

    it('both functions extract exactly once and brace-balanced', function () {
        assert.ok(EXP.text, '_expectedEntityKey must be extractable');
        assert.ok(EXP.unique, '_expectedEntityKey must be declared exactly once');
        assert.ok(EXP.balanced, '_expectedEntityKey extraction must be brace-balanced');
        assert.ok(UNA.text, '_unattachedEntities must be extractable');
        assert.ok(UNA.unique, '_unattachedEntities must be declared exactly once');
        assert.ok(UNA.balanced, '_unattachedEntities extraction must be brace-balanced');
    });

    it('the extractor cannot fire on a name that is not there', function () {
        // Without this, a silently-zero extraction would make every arm below
        // vacuous — the functions would be null and nothing would be executed.
        var bogus = extractFn(src, '_zzB555NotAFunction');
        assert.equal(bogus.text, null);
        assert.equal(bogus.balanced, false);
    });

    it('both extractions produced callable functions', function () {
        assert.equal(typeof expectedEntityKey, 'function');
        assert.equal(typeof unattachedEntities, 'function');
    });
});


describe('#B555 §01 - source pins: the guard is wired into the attach loop', function () {

    it('step 2 retains each instance rather than discarding the construction', function () {
        assert.ok(src.indexOf('nttInstances[nttClass] = new entitiesManager[nttClass](conn);') > -1,
            '#B555: the instance is the only handle that can see the `hasOwnEvents` opt-out');
        // The discarding form legitimately SURVIVES once, in the dev-only
        // `reloadModels` twin, which is deliberately left unguarded: in dev each
        // connector deletes `core/model/entity.js` from require.cache and
        // re-requires it, so every connector gets a fresh registry and the
        // collision is structurally impossible. Pin the count rather than the
        // absence, so this stays honest about the one remaining site.
        // Count WHOLE LINES: the retaining form contains the discarding form as a
        // substring (`... = new entitiesManager[nttClass](conn);`), so a plain
        // substring count reads 2 and cannot tell the two shapes apart.
        var discarding = src.split('\n').filter(function (l) {
            return l.trim() === 'new entitiesManager[nttClass](conn);';
        }).length;
        assert.equal(discarding, 1,
            '#B555: exactly one discarding construction should remain (the dev reloadModels twin); found ' + discarding);
        var guardIdx = src.indexOf('var nttMissing = _unattachedEntities(');
        var reloadIdx = src.indexOf('this.reloadModels');
        assert.ok(guardIdx > -1 && reloadIdx > -1, 'both anchors must resolve');
        assert.ok(guardIdx < reloadIdx,
            '#B555: the guard belongs to the boot-time loadAllModels path, which precedes reloadModels');
        var lines = src.split('\n');
        var discardingLine = lines.findIndex(function (l) { return l.trim() === 'new entitiesManager[nttClass](conn);'; });
        var reloadLine = lines.findIndex(function (l) { return l.indexOf('this.reloadModels') > -1; });
        assert.ok(discardingLine > reloadLine && reloadLine > -1,
            '#B555: the surviving discarding construction must be the one inside reloadModels');
    });

    it('the loop calls the guard with the model, the class map and the instances', function () {
        assert.ok(src.indexOf('_unattachedEntities(self.models[bundle][name], entitiesManager, nttInstances)') > -1,
            '#B555: the guard must be given the model object it is judging');
    });

    it('it fails fast the #B57 way — emerg, a synchronous flush, then exit', function () {
        var i = src.indexOf('var nttMissing = _unattachedEntities(');
        assert.ok(i > -1, 'guard call site not found');
        var block = src.slice(i, i + 1600);
        assert.match(block, /console\.emerg\(nttErr\)/,        'must log at emerg like every other model-init failure');
        assert.match(block, /fs\.writeSync\(2, nttErr/,        'process.exit() truncates async stderr on a pipe');
        assert.match(block, /process\.exit\(1\)/,              'a dead model layer must abort the boot, not serve');
        assert.ok(block.indexOf('console.emerg(nttErr)') < block.indexOf('process.exit(1)'),
            'the log must precede the exit');
    });

    it('the diagnostic names the bundle, the connector and the colliding classes', function () {
        var i = src.indexOf('var nttErr = ');
        assert.ok(i > -1, 'diagnostic not found');
        var msg = src.slice(i, i + 1400);
        assert.match(msg, /\+ bundle \+/,            'must name the bundle');
        assert.match(msg, /\+ name \+/,              'must name the connector entry');
        assert.match(msg, /nttMissing\.join/,        'must list the classes that did not attach');
        assert.match(msg, /nttMissing\.map\(_expectedEntityKey\)/,
            'must also name the model keys the caller would have looked for');
        assert.match(msg, /same class name/,         'must point at the actual cause');
    });
});


describe('#B555 §02 - _unattachedEntities over real bytes', function () {

    it('a healthy model reports nothing', function () {
        var missing = unattachedEntities(
            { _connection: {}, userEntity: {}, user: {}, orderEntity: {}, order: {} },
            { User: ctor(), Order: ctor() },
            {}
        );
        assert.deepEqual(missing, [], 'both entities attached — the guard must stay silent');
    });

    it('names the one class that did not attach', function () {
        var missing = unattachedEntities(
            { _connection: {}, userEntity: {}, user: {} },
            { User: ctor(), Order: ctor() },
            {}
        );
        assert.deepEqual(missing, ['Order']);
    });

    it('the exact #B555 shape: a bare model reports every declared class', function () {
        // This is what `getModel()` returned for the losing connector — the
        // shape the consumer measured on a deployed runtime.
        var missing = unattachedEntities(
            { _connection: {}, getConnection: function () {} },
            { User: ctor(), Order: ctor() },
            {}
        );
        assert.deepEqual(missing, ['User', 'Order']);
    });

    it('an entity opting out with hasOwnEvents is legitimately absent, not reported', function () {
        // setListeners() returns before updateModel() for it, so it never
        // attaches by design. Reported, it would abort a healthy boot.
        var missing = unattachedEntities(
            { _connection: {} },
            { Custom: ctor() },
            { Custom: { hasOwnEvents: true } }
        );
        assert.deepEqual(missing, [], 'the documented opt-out must not trip the guard');
    });

    it('the opt-out is read off the INSTANCE, so a same-named class without it still reports', function () {
        var missing = unattachedEntities({ _connection: {} }, { Custom: ctor() }, { Custom: {} });
        assert.deepEqual(missing, ['Custom']);
    });

    it('an entirely absent model object reports every class instead of throwing', function () {
        assert.deepEqual(unattachedEntities(undefined, { User: ctor() }, {}), ['User']);
        assert.deepEqual(unattachedEntities(null, { User: ctor() }, {}), ['User']);
    });

    it('a missing instances map is tolerated', function () {
        assert.deepEqual(unattachedEntities({ userEntity: {} }, { User: ctor() }, null), []);
    });

    it('no declared classes means nothing to report', function () {
        assert.deepEqual(unattachedEntities({ _connection: {} }, {}, {}), []);
    });
});


describe('#B555 §03 - _expectedEntityKey over real bytes', function () {

    it('lowercases the first character and appends Entity', function () {
        assert.equal(expectedEntityKey('User'), 'userEntity');
        assert.equal(expectedEntityKey('Order'), 'orderEntity');
    });

    it('does not double the suffix on a name that already carries it', function () {
        assert.equal(expectedEntityKey('UserEntity'), 'userEntity');
    });

    it('matches the key entity.js actually writes', function () {
        // entity.js derives it the same way before calling updateModel; if the
        // two ever diverge this guard would abort healthy boots.
        var entitySrc = fs.readFileSync(path.join(FW, 'core/model/entity.js'), 'utf8');
        assert.ok(entitySrc.indexOf("self.name.substring(0, 1).toLowerCase() + self.name.substring(1)") > -1,
            'entity.js must still derive the camel form the same way');
        assert.ok(entitySrc.indexOf("entityName = entityName + 'Entity'") > -1,
            'entity.js must still append the Entity suffix when absent');
    });
});
