'use strict';
/**
 * #B555 - the entity singleton registry is keyed on the BARE class name.
 *
 * `core/model/entity.js` hangs a static bag on the exported constructor -
 * `EntitySuper[<ClassName>]` - and `init()` returns the registered instance
 * whenever one exists (:148-151), skipping `setListeners()`, the only path to
 * `modelUtil.updateModel()` (:615/:621). Nothing in the key names the bundle or
 * the model, so two connectors of ONE bundle that build a class with the same
 * name collide: the connector whose model is walked SECOND by the attach loop
 * (`lib/model.js:307`, connection-ready order) is left with an entity-less model
 * - `getModel()` returns the bare `{ _connection, getConnection }` shell -
 * silently, for the life of the process. Two entries sharing a `database` (the
 * consumer report) guarantee identical class names; two databases each carrying
 * a `user.js` collide the same way.
 *
 * Dev mode cannot show it: every connector cache-busts and re-requires
 * `entity.js`, so each one gets a fresh registry (§04 pins that as a control).
 *
 * Harness: the REAL sqlite connector factory (`core/connectors/sqlite/index.js`)
 * against tagged stub connections (its `init` only stores `conn`), the REAL
 * `entity.js` and the REAL `lib/model.js` ModelUtil, driven through the exact
 * per-model sequence `lib/model.js:314-345` performs: factory -> setConnection
 * -> setModelEntity -> `new`. No database, no server, no timers - sqlite
 * readiness is synchronous, so the order the scene attaches models in IS the
 * ready order. Every arm uses its own temp root, bundle name and class name:
 * the registry is process-wide, so reuse across arms would be the defect leaking
 * into the harness.
 *
 * Arms:
 *   §00 controls          - disjoint class names attach both (the instrument can
 *                           read CORRECT); a lone model's held entity is WIRED
 *                           (the harness can tell a wired entity from a bare one)
 *   §01 same database     - A attached first, then B: B must still receive its own
 *                           entity, bound to its own connection      [red pre-fix]
 *   §02 order swapped     - B first, then A: the loser follows the ORDER, not the
 *                           name                                     [red pre-fix]
 *   §03 two databases     - different dirs, same class name: the second still
 *                           collides                                 [red pre-fix]
 *   §04 dev-mode control  - the §01 scene under NODE_ENV_IS_DEV='true' attaches
 *                           both (the masking that kept this out of local drives)
 *
 * B555_DIAG=1 prints the observed shape of each scene (harmless when green).
 */

// Must be set BEFORE the connector factory runs - the sqlite factory reads
// `isCacheless` per call, entity.js per construction (both from this variable).
process.env.NODE_ENV_IS_DEV = 'false';

var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');

var FW   = path.resolve(require('../fw'));
var REPO = path.resolve(__dirname, '../..');

// --- globals bootstrap (mirrors connector-settle-parity.test.js) ------------
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(FW + '/helpers');
setPath('gina', { core: path.join(FW, 'core') });

var ginaMain  = require.resolve(REPO);
var _inherits = require(FW + '/lib/inherits/src/main.js');
var _merge    = require(FW + '/lib/merge/src/main.js');
var ModelUtil = require(FW + '/lib/model');
if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
    require.cache[ginaMain] = {
        id: ginaMain, filename: ginaMain, loaded: true,
        exports: { lib: { logger: console, helpers: {}, inherits: _inherits, merge: _merge, Model: ModelUtil } }
    };
}

// ModelUtil is a singleton: this instance is the SAME object entity.js's own
// `new lib.Model()` (entity.js:93) resolves to, so `mu.models` is what
// `updateModel()` writes into and what `getModel()` reads.
var mu     = new ModelUtil();
var SQLITE = path.join(FW, 'core/connectors/sqlite/index.js');
var TMP    = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b555-'));
var DIAG   = /^1$/.test(process.env.B555_DIAG || '');

after(function () { fs.rmSync(TMP, { recursive: true, force: true }); });

/**
 * A tagged stub connection - the sqlite factory's `init` only stores it (no
 * `sql/` dir is ever written here), and equality on the tag object is what lets
 * an arm tell WHICH connection an entity ended up bound to.
 *
 * @inner
 * @param {string} tag - a label unique to one (bundle, model)
 * @returns {object} the stub
 */
function stubConn(tag) {
    return {
        _tag: tag,
        prepare: function () {
            return {
                all: function () { return []; },
                get: function () { return null; },
                run: function () { return { changes: 0 }; }
            };
        }
    };
}

/**
 * Write `<root>/bundle/models/<database>/entities/<file>.js` exporting a bare
 * constructor - the minimal entity shape the connector wraps with `inherits`.
 *
 * @inner
 * @param {string} root      - scene root
 * @param {string} database  - the connectors.json `database` value (the dir key)
 * @param {string} file      - entity filename without extension (=> class name)
 * @param {string} className - the constructor name to export
 * @returns {void}
 */
function writeEntity(root, database, file, className) {
    var dir = path.join(root, 'bundle/models', database, 'entities');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file + '.js'),
        'function ' + className + '(conn) {}\nmodule.exports = ' + className + ';\n');
}

/**
 * Attach ONE model exactly as `lib/model.js:314-345` does for each connector
 * once every connection is ready: run the connector factory with the infos the
 * boot passes, register the connection and the classes, then `new` each class.
 * The ORDER in which a scene calls this is the connection-ready order.
 *
 * @inner
 * @param {string} root     - scene root (holds `bundle/models/...`)
 * @param {string} bundle   - bundle name
 * @param {string} model    - the connectors.json entry key
 * @param {string} database - the entry's `database` value
 * @returns {{conn: object, manager: object, built: Object<string, object>}}
 */
function attach(root, bundle, model, database) {
    var conn = stubConn(bundle + '/' + model);
    setPath('project', root);
    setPath('bundle', path.join(root, 'bundle'));
    var Sqlite  = require(SQLITE);
    var manager = new Sqlite(conn, { model: model, bundle: bundle, database: database, scope: 'local' }); // :314
    mu.setConnection(bundle, model, conn);                                                              // :316
    var cls;
    for (cls in manager) { mu.setModelEntity(bundle, model, cls, manager[cls]); }                        // :339
    var built = {};
    for (cls in manager) { built[cls] = new manager[cls](conn); }                                         // :344
    return { conn: conn, manager: manager, built: built };
}

/** @inner @param {string} bundle @param {string} model @returns {object} the model object `getModel()` would return */
function modelOf(bundle, model) { return mu.models[bundle][model]; }

/**
 * The key `updateModel()` writes for a class: entity.js lowercases the first
 * char of the class name and appends `Entity` (`Alpha` -> `alphaEntity`, plus
 * the `alpha` alias) - measured, the boot never writes `AlphaEntity`.
 *
 * @inner
 * @param {string} cls - bare class name
 * @returns {string} the model key
 */
function keyOf(cls) { return cls.substring(0, 1).toLowerCase() + cls.substring(1) + 'Entity'; }

/**
 * Assert a model carries its own `<cls>Entity`, bound to its own connection.
 * The FIRST assertion is the one that goes red pre-fix for the losing model
 * (the key is simply absent); the second discriminates "attached" from
 * "attached but aliased to the other connector's instance".
 *
 * @inner
 * @param {string} bundle
 * @param {string} model
 * @param {string} cls   - bare class name
 * @param {object} conn  - the connection this model was attached with
 * @param {string} label - arm label for the failure message
 * @returns {void}
 */
function assertOwn(bundle, model, cls, conn, label) {
    var m   = modelOf(bundle, model);
    var key = keyOf(cls);
    assert.ok(m[key],
        label + ': model `' + model + '` must carry `' + key + '` after the attach loop - got keys '
        + JSON.stringify(Object.keys(m)) + ' (#B555: the bare-name registry short-circuit left it entity-less)');
    assert.ok(Array.isArray(m[key]._triggers),
        label + ': `' + model + '.' + key + '` must be a WIRED entity (setListeners ran), not a bare instance');
    assert.equal(m[key].getConnection(), conn,
        label + ': `' + model + '.' + key + '` must be bound to its OWN connection, not the other connector\'s');
}

/** @inner @param {string} label @param {string} bundle @param {Array<string>} models @param {string} cls @returns {void} */
function diag(label, bundle, models, cls) {
    if (!DIAG) { return; }
    models.forEach(function (model) {
        var m = modelOf(bundle, model);
        var e = m[keyOf(cls)];
        console.log('[B555 DIAG] ' + label + ' | model=' + model + ' keys=' + JSON.stringify(Object.keys(m))
            + ' entityConn=' + (e ? e.getConnection()._tag : '<absent>'));
    });
}


describe('#B555 §00 - controls', function () {

    it('two connectors with DISJOINT class names both attach (the instrument reads CORRECT)', function () {
        var root = path.join(TMP, 'c00');
        writeEntity(root, 'dbx', 'ctrlone', 'Ctrlone');
        writeEntity(root, 'dby', 'ctrltwo', 'Ctrltwo');
        var a = attach(root, 'b00', 'a', 'dbx');
        var b = attach(root, 'b00', 'b', 'dby');
        assertOwn('b00', 'a', 'Ctrlone', a.conn, '§00 control');
        assertOwn('b00', 'b', 'Ctrltwo', b.conn, '§00 control');
    });

    it('a lone model\'s attached entity is a WIRED EntitySuper instance bound to its connection', function () {
        // `lib/inherits`' wrapper discards the constructor's return value, so the
        // object `new` hands back is always a fresh `this` - the instance the
        // MODEL holds is the one entity.js registered and wired through
        // setListeners (measured: the two differ). The wiring is what a later
        // arm must be able to tell apart from a bare instance.
        var root = path.join(TMP, 'c00b');
        writeEntity(root, 'dbz', 'ctrlthree', 'Ctrlthree');
        var a = attach(root, 'b00b', 'a', 'dbz');
        var held = modelOf('b00b', 'a')[keyOf('Ctrlthree')];
        assert.ok(held, '§00 control: the lone model must hold its entity');
        assert.ok(Array.isArray(held._triggers), '§00 control: the held entity must be wired');
        assert.equal(held.getConnection(), a.conn, '§00 control: bound to its own connection');
        assert.equal(typeof a.built.Ctrlthree.getConnection, 'function', '§00 control: `new` yields a real EntitySuper instance');
    });
});


describe('#B555 §01 - two connectors sharing a database, A ready first', function () {

    it('B, attached second, still receives its own entity bound to its own connection', function () {
        var root = path.join(TMP, 's01');
        writeEntity(root, 'shared01', 'alpha', 'Alpha');
        var a = attach(root, 'b01', 'a', 'shared01');
        var b = attach(root, 'b01', 'b', 'shared01');
        diag('§01 same db, A then B', 'b01', ['a', 'b'], 'Alpha');
        if (DIAG) {
            console.log('[B555 DIAG] §01 new-on-B yielded a wired instance: ' + Array.isArray(b.built.Alpha._triggers)
                + ' | new-on-B getConnection tag: ' + b.built.Alpha.getConnection()._tag
                + ' | new-on-B === A\'s held instance: ' + (b.built.Alpha === modelOf('b01', 'a')[keyOf('Alpha')]));
        }
        assertOwn('b01', 'a', 'Alpha', a.conn, '§01 winner');
        assertOwn('b01', 'b', 'Alpha', b.conn, '§01 loser');
        assert.notEqual(modelOf('b01', 'a')[keyOf('Alpha')], modelOf('b01', 'b')[keyOf('Alpha')],
            '§01: the two models must hold DISTINCT instances');
    });

    it('getModelEntity() for B resolves to a WIRED instance bound to B\'s connection', function () {
        // The class IS registered for B (setModelEntity ran), so getModelEntity()
        // "resolves" pre-fix too - but `new` on B hits the short-circuit, so what
        // it hands back is a fresh instance that was never WIRED (no
        // setListeners) and never attached. A second, separate shape of the
        // same defect: the lookup succeeds and returns a half-built entity.
        var root = path.join(TMP, 's01b');
        writeEntity(root, 'shared01b', 'alphatwo', 'Alphatwo');
        attach(root, 'b01b', 'a', 'shared01b');
        var b = attach(root, 'b01b', 'b', 'shared01b');
        var viaLookup = global.getModelEntity('b01b', 'b', 'AlphatwoEntity', b.conn);
        assert.ok(viaLookup, '§01b: getModelEntity() must resolve for B');
        assert.ok(Array.isArray(viaLookup._triggers),
            '§01b: getModelEntity(b) must hand back a WIRED entity, not a bare instance the registry short-circuit left unwired');
        assert.equal(viaLookup.getConnection(), b.conn,
            '§01b: getModelEntity(b) must be bound to B\'s connection');
    });
});


describe('#B555 §02 - the same scene with the ready order swapped', function () {

    it('A, now attached second, is the one that must still receive its own entity (order, not name)', function () {
        var root = path.join(TMP, 's02');
        writeEntity(root, 'shared02', 'beta', 'Beta');
        var b = attach(root, 'b02', 'b', 'shared02');
        var a = attach(root, 'b02', 'a', 'shared02');
        diag('§02 same db, B then A', 'b02', ['b', 'a'], 'Beta');
        assertOwn('b02', 'b', 'Beta', b.conn, '§02 winner');
        assertOwn('b02', 'a', 'Beta', a.conn, '§02 loser');
    });
});


describe('#B555 §03 - two DIFFERENT databases whose entity dirs carry the same class name', function () {

    it('the second connector still collides on the class name alone', function () {
        var root = path.join(TMP, 's03');
        writeEntity(root, 'db03one', 'gamma', 'Gamma');
        writeEntity(root, 'db03two', 'gamma', 'Gamma');
        var a = attach(root, 'b03', 'a', 'db03one');
        var b = attach(root, 'b03', 'b', 'db03two');
        diag('§03 two dbs, same class', 'b03', ['a', 'b'], 'Gamma');
        assertOwn('b03', 'a', 'Gamma', a.conn, '§03 winner');
        assertOwn('b03', 'b', 'Gamma', b.conn, '§03 loser');
    });
});


describe('#B555 §04 - dev-mode control', function () {

    // Runs LAST on purpose: dev mode cache-busts entity.js per connector, so the
    // registry a later arm would see is whichever module loaded most recently.
    it('the §01 scene under NODE_ENV_IS_DEV=true attaches both (dev cache-busting masks the defect)', function () {
        process.env.NODE_ENV_IS_DEV = 'true';
        try {
            var root = path.join(TMP, 's04');
            writeEntity(root, 'shared04', 'delta', 'Delta');
            var a = attach(root, 'b04', 'a', 'shared04');
            var b = attach(root, 'b04', 'b', 'shared04');
            diag('§04 dev mode, A then B', 'b04', ['a', 'b'], 'Delta');
            assertOwn('b04', 'a', 'Delta', a.conn, '§04 dev control');
            assertOwn('b04', 'b', 'Delta', b.conn, '§04 dev control');
        } finally {
            process.env.NODE_ENV_IS_DEV = 'false';
        }
    });
});
