'use strict';
/**
 * #D47 — the SQLite session store reads its file path from `file`, like the
 * SQLite job and kv stores.
 *
 * A `connectors.json` entry is read by two consumers. The model layer builds a
 * SQLite connector for EVERY entry at boot, and that connector reads `database`
 * as a NAME under the gina home (`<home>/<database>.sqlite`) and a path only
 * from `file`. The session store read only `database`. So a path in `database`
 * stopped the boot (the connector could not open `<home>/<path>.sqlite`), and a
 * path in `file` was ignored by the store, which wrote its sessions to its
 * default file instead. The store now resolves, in order: `options.file`,
 * `options.database`, connectors.json `file`, connectors.json `database`, then
 * `<gina home>/sessions-<bundle>.db`.
 *
 * Strategy (the method of the #B163 session-store tests): the store cannot be
 * require()d standalone — it boots `core/gna` — so the `defaultDbPath` and
 * `dbPath` statements are EXTRACTED from the shipped source and executed as
 * real bytes. Each extraction is count-gated, so a regex that matched nothing
 * cannot pass the arms after it vacuously. Every free variable of the two
 * statements is passed as a parameter (no closure is lifted out).
 *
 *   §00 extraction controls
 *   §01–§05 `file` is honoured and its precedence holds
 *   §06–§08 unchanged behaviour: `database` alone, the default, its location
 *   §09 the scaffolded bundle template shows the SQLite sample with `file`
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var STORE    = path.join(FW, 'core/connectors/sqlite/lib/session-store.js');
var TEMPLATE = path.join(FW, 'core/template/boilerplate/bundle/index.js');

/**
 * Drop full-line comments so an extraction can never anchor on a JSDoc
 * mention or a `// was:` line.
 *
 * @param   {string} src
 * @returns {string}
 * @inner
 */
function stripComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

/**
 * Extract the single-line `var <name> = …;` statement from the store source
 * and return an evaluator that runs those exact bytes.
 *
 * @param   {string}   src    - full store source
 * @param   {string}   name   - the declared variable
 * @param   {string[]} params - every free variable of the statement
 * @returns {{count: number, fn: ?function}} `fn(...params)` returns the variable's value
 * @inner
 */
function extract(src, name, params) {
    var re = new RegExp('^\\s*var ' + name + '\\s+=\\s+[^\\n]*;\\s*$', 'mg');
    var m  = stripComments(src).match(re) || [];
    if (m.length !== 1) {
        return { count: m.length, fn: null };
    }
    return { count: 1, fn: new Function(params.join(', '), m[0] + '\nreturn ' + name + ';') };
}

describe('#D47 — SQLite session store: the file path comes from `file`', function () {

    var DEFAULT = '/home/u/.gina/sessions-api.db';
    var dbPath, defaultDbPath;

    before(function () {
        var src = fs.readFileSync(STORE, 'utf8');
        dbPath        = extract(src, 'dbPath', ['options', 'connConf', 'defaultDbPath']);
        defaultDbPath = extract(src, 'defaultDbPath', ['_', 'getPath', 'bundle']);
    });

    /**
     * Run the extracted `dbPath` statement.
     *
     * @param   {object} [options]  - instance options
     * @param   {object} [connConf] - the connectors.json `session` entry
     * @returns {string}
     * @inner
     */
    function resolve(options, connConf) {
        return dbPath.fn(options || {}, connConf || {}, DEFAULT);
    }

    it('§00 each statement is found exactly once in the shipped source', function () {
        assert.equal(dbPath.count, 1, '`var dbPath = …;` must match once (comments stripped)');
        assert.equal(defaultDbPath.count, 1, '`var defaultDbPath = …;` must match once (comments stripped)');
    });

    it('§01 a connectors.json `file` is the path the store opens', function () {
        assert.equal(resolve({}, { file: '/data/sessions.db' }), '/data/sessions.db');
    });

    it('§02 `file` wins over `database` in connectors.json', function () {
        assert.equal(resolve({}, { file: '/data/a.db', database: '/data/b.db' }), '/data/a.db');
    });

    it('§03 `file: ":memory:"` keeps the store in memory', function () {
        assert.equal(resolve({}, { file: ':memory:' }), ':memory:');
    });

    it('§04 an instance option wins over connectors.json', function () {
        assert.equal(resolve({ file: '/opt/x.db' }, { file: '/data/a.db', database: '/data/b.db' }), '/opt/x.db');
        assert.equal(resolve({ database: '/opt/y.db' }, { file: '/data/a.db' }), '/opt/y.db');
    });

    it('§05 `options.file` wins over `options.database`', function () {
        assert.equal(resolve({ file: '/opt/x.db', database: '/opt/y.db' }, {}), '/opt/x.db');
    });

    it('§06 `database` alone still works, so existing configurations are unchanged', function () {
        assert.equal(resolve({}, { database: '/data/b.db' }), '/data/b.db');
        assert.equal(resolve({ database: ':memory:' }, {}), ':memory:');
    });

    it('§07 with neither key, the store uses its per-bundle default', function () {
        assert.equal(resolve({}, {}), DEFAULT);
    });

    it('§08 the default file sits directly under the gina home, not under a version directory', function () {
        var _       = function (p) { return String(p).replace(/\/+/g, '/'); };
        var getPath = function (key) { return (key === 'gina') ? { home: '/home/u/.gina' } : null; };
        assert.equal(defaultDbPath.fn(_, getPath, 'api'), '/home/u/.gina/sessions-api.db');
    });

    it('§09 the scaffolded bundle template shows the SQLite sample with `file`', function () {
        var tpl = fs.readFileSync(TEMPLATE, 'utf8');
        assert.ok(tpl.indexOf('{ "session": { "connector": "sqlite", "file": ":memory:"') > -1,
            'the SQLite sample keys its in-memory store with `file`');
        assert.ok(tpl.indexOf('"connector": "sqlite", "database"') < 0,
            'the SQLite sample no longer puts a path or ":memory:" in `database`');
    });
});
