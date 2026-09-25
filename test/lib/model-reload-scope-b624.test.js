/**
 * #B624 — `reloadModels` rebuilds each connector's entity manager with the
 * connector entry's `scope`, as `loadAllModels` already does at boot.
 *
 * Before the fix the reload handed the connector factory `{ model, bundle,
 * database }` and no `scope`, so a connector that stamps and filters on the scope
 * (couchbase: `_scope` on insert, `$scope` in statements) fell back to
 * `NODE_SCOPE` after a reload whenever the connectors.json entry declared a
 * different one. The only live callers are the couchbase reconnect paths, whose
 * trigger cannot fire on SDK 4.x, so the defect is latent there; these pins hold
 * the contract for the day a reload runs.
 *
 * Sections:
 *   01 — source pins on the comment-stripped lib/model.js: both connector factory
 *        calls pass `scope: conf.content['connectors'][name].scope`. CONTROL: both
 *        pass the `database` key, so the instrument sees both calls.
 *   02 — behavioural, on the real `reloadModels`: a spy connector under a temp
 *        GINA_FRAMEWORK_DIR records the `infos` each factory call receives. The
 *        reload delivers the entry's `scope`, leaves it undefined when the entry
 *        declares none (CONTROL — the connector then falls back to NODE_SCOPE
 *        itself), and calls back exactly once with `false`.
 *
 * Red-first: the 01 scope pin and the 02 scope arm fail on the pre-fix bytes; the
 * two controls pass on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW        = path.resolve(require('../fw'));
var MODEL_SRC = path.join(FW, 'lib/model.js');

var SCOPE_ARG    = "scope: conf.content['connectors'][name].scope";
var DATABASE_ARG = "database: conf.content['connectors'][name].database";

/**
 * Remove block and line comments so a pin counts code, never prose that quotes it.
 *
 * @inner
 * @param {string} src - JavaScript source
 * @returns {string} the source without comments
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

/**
 * Count non-overlapping occurrences of a literal.
 *
 * @inner
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function count(haystack, needle) {
    var n = 0, i = haystack.indexOf(needle);
    while (i > -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
    return n;
}

describe('01 - both connector factory calls pass the entry scope (source pins)', function () {

    var raw  = fs.readFileSync(MODEL_SRC, 'utf8');
    var code = stripComments(raw);

    it('CONTROL: the instrument sees both factory calls (the `database` key)', function () {
        assert.equal(count(code, DATABASE_ARG), 2);
        assert.ok(count(raw, DATABASE_ARG) >= count(code, DATABASE_ARG),
            'the strip must never ADD occurrences');
    });

    it('both calls pass `scope` — loadAllModels and reloadModels', function () {
        assert.equal(count(code, SCOPE_ARG), 2,
            'expected the scope key on both factory calls (it was on the boot call only)');
    });
});

describe('02 - reloadModels delivers the connector entry scope (behavioural)', function () {

    var TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b624-'));
    var FAKE_FW  = path.join(TMP, 'fw');
    var ModelUtil, mu;

    before(function () {
        process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
        require('module').Module._initPaths();
        require(path.join(FW, 'helpers'));

        // A spy connector: records every `infos` it is built with, exposes no entity.
        var spyDir = path.join(FAKE_FW, 'core/connectors/spy');
        fs.mkdirSync(spyDir, { recursive: true });
        fs.writeFileSync(path.join(spyDir, 'index.js'),
            'module.exports = function (conn, infos) {\n'
            + '    (global.__b624Infos = global.__b624Infos || []).push(infos);\n'
            + '    return {};\n'
            + '};\n');

        // reloadModels builds the connector path from the bare global the boot defines.
        assert.equal(typeof global.GINA_FRAMEWORK_DIR, 'undefined',
            'harness: GINA_FRAMEWORK_DIR must not be pre-defined in this test process');
        global.GINA_FRAMEWORK_DIR = FAKE_FW;

        ModelUtil = require(MODEL_SRC);
        mu = new ModelUtil();
    });

    after(function () {
        delete global.GINA_FRAMEWORK_DIR;
        delete global.__b624Infos;
        fs.rmSync(TMP, { recursive: true, force: true });
    });

    /**
     * Run one reload over a single connector entry and return what the spy saw.
     *
     * @inner
     * @param {object} entry - the connectors.json entry for connector `db`
     * @returns {{ infos: Array<object>, calls: Array<Array> }}
     */
    function reloadWith(entry) {
        global.__b624Infos = [];
        mu.models = { bundleA: { db: {} } };
        setContext('modelConnectors', { bundleA: { db: { conn: { spy: true } } } });
        var calls = [];
        mu.reloadModels({
            bundle     : 'bundleA',
            modelsPath : path.join(TMP, 'models'),
            content    : { connectors: { db: entry } }
        }, function () { calls.push(Array.prototype.slice.call(arguments)); });
        return { infos: global.__b624Infos.slice(), calls: calls };
    }

    it('the spy connector is built once per reload, with the entry database (instrument check)', function () {
        var r = reloadWith({ connector: 'spy', database: 'd1', scope: 'beta' });
        assert.equal(r.infos.length, 1);
        assert.equal(r.infos[0].database, 'd1');
        assert.equal(r.infos[0].model, 'db');
        assert.equal(r.infos[0].bundle, 'bundleA');
    });

    it('the reload passes the entry scope to the connector', function () {
        var r = reloadWith({ connector: 'spy', database: 'd1', scope: 'beta' });
        assert.equal(r.infos.length, 1);
        assert.equal(r.infos[0].scope, 'beta');
    });

    it('CONTROL: an entry without a scope reaches the connector without one', function () {
        var r = reloadWith({ connector: 'spy', database: 'd1' });
        assert.equal(r.infos.length, 1);
        assert.equal(r.infos[0].scope, undefined);
    });

    it('the reload calls back exactly once, with false', function () {
        var r = reloadWith({ connector: 'spy', database: 'd1', scope: 'beta' });
        assert.deepEqual(r.calls, [[false]]);
    });
});
