/**
 * #B608 — the couchbase connector no longer writes caller or configuration
 * values into N1QL statement TEXT unvalidated.
 *
 * Three sites built the statement by string concatenation instead of binding a
 * query parameter or validating an identifier:
 *
 *   - `$scope` became `'<scope>'` from `connectors.json > scope` or
 *     `NODE_SCOPE`, neither validated, through a string replacement — and the
 *     same unvalidated value was stamped as `_scope` on every entity prototype.
 *     Fix: `resolveScope()` resolves it ONCE at factory load against
 *     `^[A-Za-z0-9_./-]+$` and ends the boot through the explicit terminal
 *     (console.emerg + fs.writeSync(2) + process.exit(1)) when it does not match.
 *   - a `$N` in field-path position (`doc.flags.$2`) cannot be bound, so its
 *     argument is spliced after the dot — with no grammar. Fix:
 *     `getInvalidFieldPathError()` admits `identifier(.identifier)*` only and the
 *     call is refused before dispatch, delivered like #B243 (the callback when
 *     there is one, a synchronous throw otherwise).
 *   - `SEARCH()` had every positional value spliced into its span as a
 *     double-quoted literal, unescaped. Fix: the substitution is retired — the
 *     values are already bound in `queryOptions.parameters`, and the query
 *     service binds a parameter used as SEARCH()'s query argument.
 *
 * What each section exists for:
 *   §01 resolveScope()            — extracted from the shipped bytes and executed.
 *   §02 getInvalidFieldPathError() — extracted from the shipped bytes and executed.
 *   §03 the real connector, booted against a recording cluster stub: `$scope`
 *       substitution, the field-path refusal in both call forms, and SEARCH()
 *       statements that keep their `$N`. Arms marked "control" pass on the
 *       pre-fix connector too, so a broken harness reads differently from a
 *       broken connector.
 *   §04 the boot terminal, in a CHILD process (a `process.exit(1)` in this
 *       process would take the whole file down): a refused scope exits 1 with
 *       the coded message on stderr; valid scopes boot (controls).
 *   §05 source pins, comment-stripped, each negative pin paired with a raw-text
 *       check proving its needle is still present in the file's comments.
 *
 * Red-first seam: `GINA_COUCHBASE_CONNECTOR_SRC=<path>` makes BOTH the source
 * pins and the booted connector (in this process and in the §04 children) use
 * THAT file instead of the tree's. Point it at the pre-fix bytes — relative
 * requires and `__dirname` rewritten to absolute paths — and every fix arm goes
 * red while every control stays green.
 *
 * Test names describe the VALUES exercised ("a key containing a space"), never
 * payloads.
 */
'use strict';

// Must be set BEFORE the connector is required — `envIsDev` is captured at
// factory load, and dev mode re-reads the .sql file on every call.
process.env.NODE_ENV_IS_DEV = 'false';

var path          = require('path');
var fs            = require('fs');
var os            = require('os');
var childProcess  = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert        = require('node:assert/strict');

var FW       = path.resolve(require('../fw'));
var REPO     = path.resolve(__dirname, '../..');
var CONN_SRC = process.env.GINA_COUCHBASE_CONNECTOR_SRC || path.join(FW, 'core/connectors/couchbase/index.js');
var src      = fs.readFileSync(CONN_SRC, 'utf8');

// ─── globals bootstrap (mirrors test/core/couchbase-concurrency.test.js) ─────
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

// ─── throwaway project: stub SDK, one entity, one .sql file per shape ────────
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b608-'));
fs.mkdirSync(path.join(TMP, 'node_modules/couchbase'), { recursive: true });
fs.writeFileSync(
    path.join(TMP, 'node_modules/couchbase/index.js'),
    "module.exports = { QueryScanConsistency: { NotBounded: 'not_bounded', RequestPlus: 'request_plus' } };\n"
);
fs.mkdirSync(path.join(TMP, 'bundle/models/db/entities'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'bundle/models/db/n1ql/thing'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'bundle/models/db/entities/thing.js'),
    'function Thing(conn) {}\nmodule.exports = Thing;\n');

/**
 * Writes one `.sql` method file for the `thing` entity.
 *
 * @inner
 * @param {string} method - method name (the file name)
 * @param {string} body - the file content
 * @returns {void}
 */
function sql(method, body) {
    fs.writeFileSync(path.join(TMP, 'bundle/models/db/n1ql/thing', method + '.sql'), body);
}

// `$scope` in a value position, next to a longer placeholder that merely starts with `$scope`.
sql('byKind',
    '/**\n * byKind\n * @param {string} $1\n */\n'
  + 'SELECT t.* FROM db t WHERE t._scope = $scope AND t.kind = $1 AND t.ref = $scopeId\n');
// a `$N` in field-path position (no declared types: nothing is cast).
sql('setFlag',
    '/**\n * setFlag\n * @param $1 - document id\n * @param $2 - flag name\n * @param $3 - flag value\n */\n'
  + 'UPDATE db AS d SET d.flags.$2 = $3 WHERE d.id = $1\n');
// SEARCH() with its query argument a complete request object, the term nested inside.
sql('findByTerm',
    '/**\n * findByTerm\n * @param {string} $1\n * @param {string} $2\n */\n'
  + 'SELECT t.* FROM db t WHERE t.ownerId = $1 AND SEARCH(t, { "query": { "match": $2, "field": "name" }, "size": 1 })\n');
// SEARCH() followed by a parenthesised numeric comparison.
sql('findRanked',
    '/**\n * findRanked\n * @param {string} $1\n * @param {string} $2\n * @param {number} $3\n */\n'
  + 'SELECT t.* FROM db t WHERE SEARCH(t, $2) AND (t.rank > $3) AND t.ownerId = $1\n');

setPath('project', TMP);
setPath('bundle',  path.join(TMP, 'bundle'));

// ─── recording cluster stub ─────────────────────────────────────────────────
var records = [];
var conn = {
    sdk      : { version: 4 },
    _cluster : {
        query: function (q, opts) {
            records.push({ q: String(q), opts: opts });
            return Promise.resolve({ rows: [], meta: {} });
        }
    }
};

/** @inner @param {number} [ms=10] @returns {Promise<void>} */
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 10); }); }

/**
 * Calls an entity method in its explicit-callback form and resolves with what
 * the callback received — never hangs: a callback that never fires resolves
 * `{ timedOut: true }` and fails its assertion instead of stalling the file.
 *
 * @inner
 * @param {string} method
 * @param {Array} args - the method arguments, callback excluded
 * @returns {Promise<{err: *, data: *, timedOut: boolean}>}
 */
function viaCallback(method, args) {
    return new Promise(function (resolve) {
        var guard = setTimeout(function () { resolve({ err: null, data: null, timedOut: true }); }, 2000);
        ent[method].apply(ent, args.concat([function (err, data) {
            clearTimeout(guard);
            resolve({ err: err, data: data, timedOut: false });
        }]));
    });
}

var entities, ent;

before(function () {
    require(FW + '/lib');
    var Couchbase = require(CONN_SRC);
    entities = new Couchbase(conn, { database: 'db', model: 'model', bundle: 'bundle', scope: 'local' });

    var mu = new ModelUtil();
    mu.setConnection('bundle', 'model', conn);
    mu.setModelEntity('bundle', 'model', 'Thing', entities.Thing);
    new entities.Thing(conn);

    var EntitySuper = require(path.join(FW, 'core/model/entity.js'));
    ent = EntitySuper[EntitySuper.key('bundle', 'model', 'Thing')].instance;
});

after(function () { fs.rmSync(TMP, { recursive: true, force: true }); });

// ─── extraction helpers ──────────────────────────────────────────────────────

/**
 * Slices a factory-level `var <name> = function(…) {…};` out of the source,
 * between two text anchors that must each occur exactly once, then cuts back to
 * the function's own terminator (the end anchor sits in the NEXT JSDoc block).
 *
 * @inner
 * @param {string} startNeedle
 * @param {string} endNeedle
 * @returns {string} the function's text
 */
function extract(startNeedle, endNeedle) {
    var a = src.indexOf(startNeedle);
    assert.notEqual(a, -1, 'start anchor not found: ' + startNeedle);
    assert.equal(src.indexOf(startNeedle, a + 1), -1, 'start anchor not unique: ' + startNeedle);
    var b = src.indexOf(endNeedle, a);
    assert.notEqual(b, -1, 'end anchor not found: ' + endNeedle);
    assert.equal(src.indexOf(endNeedle, b + 1), -1, 'end anchor not unique: ' + endNeedle);
    var text = src.slice(a, b);
    text = text.slice(0, text.lastIndexOf('};') + 2);
    assert.equal(text.split('{').length, text.split('}').length,
        'braces balance — the slice is a complete function, not a truncated one');
    return text;
}

var _resolveScope = null, _fieldPathError = null;

/** @inner @returns {function(*, *): string} the shipped resolveScope() */
function resolveScope() {
    if (!_resolveScope) {
        var text = extract('var resolveScope = function(configScope, envScope) {',
                           '* #B608 — refuses a field-path key that is not an identifier path.');
        _resolveScope = new Function(text + '\nreturn resolveScope;')();
    }
    return _resolveScope;
}

/** @inner @returns {function(*, string, string, string, string): (TypeError|null)} the shipped getInvalidFieldPathError() */
function fieldPathError() {
    if (!_fieldPathError) {
        var text = extract('var getInvalidFieldPathError = function(value, placeholder, entityName, name, source) {',
                           '* #B243 — guards the assembled N1QL parameter list');
        _fieldPathError = new Function(text + '\nreturn getInvalidFieldPathError;')();
    }
    return _fieldPathError;
}

/**
 * Runs resolveScope() and returns the error it threw, or fails.
 *
 * @inner
 * @param {*} configScope
 * @param {*} envScope
 * @returns {Error}
 */
function scopeRefusal(configScope, envScope) {
    try {
        var got = resolveScope()(configScope, envScope);
        assert.fail('expected a refusal, got ' + JSON.stringify(got));
    } catch (e) {
        if (e && e.code === 'ERR_ASSERTION') { throw e; }
        return e;
    }
}

var SRC_FILE = '/bundle/models/db/n1ql/thing/setFlag.sql';

// ─────────────────────────────────────────────────────────────────────────────

describe('01 - resolveScope(): the scope is resolved once and validated', function () {

    it('the extracted slice really is resolveScope()', function () {
        var fn = resolveScope();
        assert.equal(typeof fn, 'function');
        assert.equal(fn.length, 2, 'takes (configScope, envScope)');
    });

    it('accepts the scope names gina ships, a legacy <bundle>/<scope> name, and names of letters, digits, _ . - /', function () {
        var fn = resolveScope();
        ['local', 'beta', 'production', 'testing', 'frontend/staging', 'my-scope.v2', 'Staging_1', '0'].forEach(function (s) {
            assert.equal(fn(undefined, s), s, s + ' passes through NODE_SCOPE');
            assert.equal(fn(s, 'local'), s, s + ' passes through the connector entry');
        });
    });

    it('the connector entry wins over NODE_SCOPE', function () {
        assert.equal(resolveScope()('beta', 'production'), 'beta');
    });

    it('an absent, null or empty connector entry falls back to NODE_SCOPE (the historical || precedence)', function () {
        var fn = resolveScope();
        assert.equal(fn(undefined, 'local'), 'local');
        assert.equal(fn(null, 'local'), 'local');
        assert.equal(fn('', 'local'), 'local');
    });

    it('refuses a scope containing a space, naming the connector entry as the source', function () {
        var e = scopeRefusal('two words', 'local');
        assert.equal(e.code, 'GINA_COUCHBASE_INVALID_SCOPE');
        assert.match(e.message, /connectors\.json "scope"/);
        assert.ok(e.message.indexOf('^[A-Za-z0-9_./-]+$') > -1, 'names the grammar');
    });

    it('refuses a NODE_SCOPE containing a space, naming NODE_SCOPE as the source', function () {
        var e = scopeRefusal(undefined, 'two words');
        assert.equal(e.code, 'GINA_COUCHBASE_INVALID_SCOPE');
        assert.match(e.message, /NODE_SCOPE/);
        assert.doesNotMatch(e.message, /connectors\.json/);
    });

    it('refuses scopes containing a single quote, a double quote, a backslash, a dollar sign or a newline', function () {
        ["a'b", 'a"b', 'a\\b', 'a$b', 'a\nb'].forEach(function (s) {
            var e = scopeRefusal(s, 'local');
            assert.equal(e.code, 'GINA_COUCHBASE_INVALID_SCOPE', JSON.stringify(s));
        });
    });

    it('refuses a missing scope (no entry, no NODE_SCOPE) and an empty NODE_SCOPE', function () {
        assert.equal(scopeRefusal(undefined, undefined).code, 'GINA_COUCHBASE_INVALID_SCOPE');
        assert.equal(scopeRefusal(undefined, '').code, 'GINA_COUCHBASE_INVALID_SCOPE');
    });

    it('refuses a non-string connector entry (a number) — it used to be stamped as-is', function () {
        var e = scopeRefusal(5, 'local');
        assert.equal(e.code, 'GINA_COUCHBASE_INVALID_SCOPE');
        assert.match(e.message, /\(number\)/, 'a non-string shows its type only');
        assert.match(e.message, /connectors\.json "scope"/);
    });

    it('the refused value is JSON-quoted and truncated: a newline cannot start a log line, a long value is cut', function () {
        var nl = scopeRefusal('a\nb', 'local');
        assert.equal(nl.message.indexOf('\n'), -1, 'no raw newline in the message');
        assert.ok(nl.message.indexOf('"a\\nb"') > -1, 'the escaped form is shown');
        var long = scopeRefusal(new Array(201).join('x') + ' ', 'local');
        assert.ok(long.message.indexOf(new Array(66).join('x')) === -1, 'at most 64 characters of the value');
        assert.ok(long.message.indexOf('…') > -1, 'the cut is marked');
    });
});

describe('02 - getInvalidFieldPathError(): only an identifier path is written after the dot', function () {

    it('the extracted slice really is getInvalidFieldPathError()', function () {
        var fn = fieldPathError();
        assert.equal(typeof fn, 'function');
        assert.equal(fn.length, 5);
    });

    it('accepts identifiers and dotted identifier paths', function () {
        var fn = fieldPathError();
        ['jwtLogin', 'revival3', '_x', 'a.b.c', 'A_b.C9', 'meta.count'].forEach(function (k) {
            assert.equal(fn(k, '$2', 'thing', 'setFlag', SRC_FILE), null, k);
        });
    });

    it('refuses a key containing a space, naming the method, the placeholder, the file and the grammar', function () {
        var e = fieldPathError()('two words', '$2', 'thing', 'setFlag', SRC_FILE);
        assert.ok(e instanceof TypeError);
        assert.equal(e.code, 'GINA_COUCHBASE_INVALID_FIELD_PATH');
        assert.ok(e.message.indexOf('thing#setFlag()') > -1, 'names the method');
        assert.ok(e.message.indexOf('$2') > -1, 'names the placeholder');
        assert.ok(e.message.indexOf(SRC_FILE) > -1, 'names the .sql file');
        assert.ok(e.message.indexOf('identifier(.identifier)*') > -1, 'names the grammar');
        assert.ok(e.message.indexOf('"two words"') > -1, 'shows the refused value, JSON-quoted');
    });

    it('refuses keys containing quotes, a backtick, brackets, a dash, a dollar sign or a newline', function () {
        var fn = fieldPathError();
        ["a'b", 'a"b', 'a`b', 'a[0]', 'a-b', 'a$b', 'a\nb', 'a)b', 'a=b'].forEach(function (k) {
            var e = fn(k, '$2', 'thing', 'setFlag', SRC_FILE);
            assert.ok(e && e.code === 'GINA_COUCHBASE_INVALID_FIELD_PATH', JSON.stringify(k));
        });
    });

    it('refuses an empty key, a leading digit, and a leading, trailing or doubled dot', function () {
        var fn = fieldPathError();
        ['', '3abc', '.a', 'a.', 'a..b', 'a.3b'].forEach(function (k) {
            var e = fn(k, '$2', 'thing', 'setFlag', SRC_FILE);
            assert.ok(e && e.code === 'GINA_COUCHBASE_INVALID_FIELD_PATH', JSON.stringify(k));
        });
    });

    it('refuses a non-string key (number, null, undefined, object), showing its type only', function () {
        var fn = fieldPathError();
        [3, null, undefined, { a: 1 }, true].forEach(function (k) {
            var e = fn(k, '$2', 'thing', 'setFlag', SRC_FILE);
            assert.ok(e && e.code === 'GINA_COUCHBASE_INVALID_FIELD_PATH', String(k));
        });
        assert.match(fn({ a: 1 }, '$2', 'thing', 'setFlag', SRC_FILE).message, /\(object\)/);
        assert.equal(fn({ a: 1 }, '$2', 'thing', 'setFlag', SRC_FILE).message.indexOf('"a"'), -1,
            'an object\'s content is not dumped into the message');
    });
});

describe('03 - the real connector against a recording cluster stub', function () {

    it('control: the entity prototype is stamped with the connector\'s scope', function () {
        assert.equal(entities.Thing.prototype._scope, 'local');
    });

    it('control: $scope becomes the quoted scope literal and the value parameters stay bound', async function () {
        records.length = 0;
        var r = await viaCallback('byKind', ['k1']);
        assert.equal(r.timedOut, false);
        assert.equal(records.length, 1);
        assert.ok(records[0].q.indexOf("t._scope = 'local'") > -1, records[0].q);
        assert.deepEqual(records[0].opts.parameters, ['k1']);
    });

    it('a longer placeholder that merely starts with $scope is left alone', async function () {
        records.length = 0;
        await viaCallback('byKind', ['k1']);
        assert.ok(records[0].q.indexOf('t.ref = $scopeId') > -1, records[0].q);
    });

    it('control: an identifier key is written after the dot and the other parameters stay bound', async function () {
        records.length = 0;
        var r = await viaCallback('setFlag', ['d1', 'seen', true]);
        assert.equal(r.err, false);
        assert.equal(records.length, 1);
        assert.ok(records[0].q.indexOf('SET d.flags.seen = $3 WHERE d.id = $1') > -1, records[0].q);
        assert.deepEqual(records[0].opts.parameters, ['d1', 'seen', true]);
    });

    it('control: a dotted identifier path keeps producing the multi-segment path', async function () {
        records.length = 0;
        await viaCallback('setFlag', ['d1', 'meta.count', 1]);
        assert.ok(records[0].q.indexOf('SET d.flags.meta.count = $3') > -1, records[0].q);
    });

    it('a key containing a space is refused through the callback, and nothing is dispatched', async function () {
        records.length = 0;
        var r = await viaCallback('setFlag', ['d1', 'two words', true]);
        assert.equal(r.timedOut, false, 'the callback is invoked');
        assert.ok(r.err instanceof TypeError, 'receives a TypeError, got ' + r.err);
        assert.equal(r.err.code, 'GINA_COUCHBASE_INVALID_FIELD_PATH');
        assert.ok(r.err.message.indexOf('$2') > -1, 'names the placeholder');
        await tick(20);
        assert.equal(records.length, 0, 'the statement never reaches the cluster');
    });

    it('a key containing a space is thrown synchronously in the Promise form, and nothing is dispatched', async function () {
        records.length = 0;
        assert.throws(function () { ent.setFlag('d1', 'two words', true); },
            function (e) { return e instanceof TypeError && e.code === 'GINA_COUCHBASE_INVALID_FIELD_PATH'; });
        await tick(20);
        assert.equal(records.length, 0, 'the statement never reaches the cluster');
    });

    it('a numeric key is refused (it used to be written as `.3`)', async function () {
        records.length = 0;
        var r = await viaCallback('setFlag', ['d1', 3, true]);
        assert.ok(r.err && r.err.code === 'GINA_COUCHBASE_INVALID_FIELD_PATH', 'got ' + r.err);
        await tick(20);
        assert.equal(records.length, 0);
    });

    it('a search term containing a double quote stays a bound parameter inside SEARCH()', async function () {
        records.length = 0;
        var r = await viaCallback('findByTerm', ['o1', 'ac"me']);
        assert.equal(r.err, false);
        assert.equal(records.length, 1);
        assert.ok(records[0].q.indexOf('{ "query": { "match": $2, "field": "name" }, "size": 1 }') > -1,
            'the statement keeps $2: ' + records[0].q);
        assert.equal(records[0].q.indexOf('ac"me'), -1, 'the term is not in the statement text');
        assert.deepEqual(records[0].opts.parameters, ['o1', 'ac"me']);
    });

    it('a numeric parameter after SEARCH() keeps its type instead of becoming a string literal', async function () {
        records.length = 0;
        var r = await viaCallback('findRanked', ['o1', 'name:acme', 5]);
        assert.equal(r.err, false);
        assert.ok(records[0].q.indexOf('SEARCH(t, $2) AND (t.rank > $3) AND t.ownerId = $1') > -1,
            'every placeholder stays in the statement: ' + records[0].q);
        assert.deepEqual(records[0].opts.parameters, ['o1', 'name:acme', 5]);
    });

    it('the Promise form of a SEARCH() method dispatches the same bound statement', async function () {
        records.length = 0;
        await ent.findByTerm('o2', 'globex');
        assert.equal(records.length, 1);
        assert.ok(records[0].q.indexOf('"match": $2') > -1, records[0].q);
        assert.deepEqual(records[0].opts.parameters, ['o2', 'globex']);
    });
});

describe('04 - the boot terminal, in a child process', function () {

    var RUNNER = path.join(TMP, 'b608-runner.js');

    before(function () {
        fs.writeFileSync(RUNNER, [
            "'use strict';",
            "process.env.NODE_ENV_IS_DEV = 'false';",
            "var path = require('path'), fs = require('fs');",
            "var FW = process.env.B608_FW, REPO = process.env.B608_REPO, TMP = process.env.B608_TMP;",
            "process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;",
            "require('module').Module._initPaths();",
            "require(FW + '/helpers');",
            "setPath('gina', { core: path.join(FW, 'core') });",
            "var ginaMain = require.resolve(REPO);",
            "require.cache[ginaMain] = { id: ginaMain, filename: ginaMain, loaded: true, exports: { lib: {",
            "    logger: console, helpers: {}, inherits: require(FW + '/lib/inherits/src/main.js'),",
            "    merge: require(FW + '/lib/merge/src/main.js'), Model: require(FW + '/lib/model') } } };",
            "setPath('project', TMP);",
            "setPath('bundle', path.join(TMP, 'bundle'));",
            "require(FW + '/lib');",
            "var Couchbase = require(process.env.B608_CONN_SRC);",
            "var infos = { database: 'db', model: 'model', bundle: 'bundle' };",
            "var scope = JSON.parse(process.env.B608_CONFIG_SCOPE);",
            "if (scope !== null) { infos.scope = scope; }",
            "var cluster = { query: function () { return Promise.resolve({ rows: [], meta: {} }); } };",
            "var entities = new Couchbase({ sdk: { version: 4 }, _cluster: cluster }, infos);",
            "fs.writeSync(1, '\\nBOOTED scope=' + entities.Thing.prototype._scope + '\\n');",
            "process.exit(0);",
            ''
        ].join('\n'));
    });

    /**
     * Boots the connector in a child process.
     *
     * @inner
     * @param {string|null} configScope - the connector entry's scope; null = absent
     * @param {string|undefined} nodeScope - NODE_SCOPE; undefined = unset
     * @returns {{status: number, stdout: string, stderr: string}}
     */
    function boot(configScope, nodeScope) {
        var env = Object.assign({}, process.env, {
            B608_FW: FW, B608_REPO: REPO, B608_TMP: TMP, B608_CONN_SRC: CONN_SRC,
            B608_CONFIG_SCOPE: JSON.stringify(configScope)
        });
        delete env.NODE_SCOPE;
        if (typeof nodeScope === 'string') { env.NODE_SCOPE = nodeScope; }
        var r = childProcess.spawnSync(process.execPath, [RUNNER], { env: env, encoding: 'utf8', timeout: 30000 });
        return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), error: r.error };
    }

    /** @inner @param {object} r @returns {string} */
    function detail(r) {
        return '\n  status=' + r.status + (r.error ? ' error=' + r.error.message : '')
            + '\n  stderr: ' + r.stderr.slice(-600) + '\n  stdout: ' + r.stdout.slice(-300);
    }

    it('control: a valid connector-entry scope boots and is stamped on the entity', function () {
        var r = boot('local', 'production');
        assert.equal(r.status, 0, detail(r));
        assert.ok(r.stdout.indexOf('BOOTED scope=local') > -1, detail(r));
    });

    it('control: with no connector-entry scope, a valid NODE_SCOPE boots and is stamped', function () {
        var r = boot(null, 'beta');
        assert.equal(r.status, 0, detail(r));
        assert.ok(r.stdout.indexOf('BOOTED scope=beta') > -1, detail(r));
    });

    it('a connector-entry scope containing a quote ends the boot with exit 1 and the coded reason on stderr', function () {
        var r = boot("bad'scope", 'local');
        assert.equal(r.status, 1, detail(r));
        assert.ok(r.stderr.indexOf('GINA_COUCHBASE_INVALID_SCOPE') > -1, detail(r));
        assert.ok(r.stderr.indexOf('connectors.json "scope"') > -1, 'names the source' + detail(r));
        assert.ok(r.stderr.indexOf('connector [ model ] of bundle [ bundle ]') > -1, 'names the entry and bundle' + detail(r));
        assert.equal(r.stdout.indexOf('BOOTED'), -1, 'the connector never finished loading');
    });

    it('a NODE_SCOPE containing a space ends the boot with exit 1, naming NODE_SCOPE', function () {
        var r = boot(null, 'two words');
        assert.equal(r.status, 1, detail(r));
        assert.ok(r.stderr.indexOf('GINA_COUCHBASE_INVALID_SCOPE') > -1, detail(r));
        assert.ok(r.stderr.indexOf('NODE_SCOPE') > -1, detail(r));
        assert.equal(r.stdout.indexOf('BOOTED'), -1);
    });
});

describe('05 - source pins (comment-stripped)', function () {

    /**
     * Strips block comments and whole-line `//` comments, so a negative pin cannot
     * match the fix's own explanation — or the retired code kept in place as
     * commented-out lines. Same strip as test/core/couchbase-concurrency.test.js §07.
     *
     * @inner
     * @param {string} t - raw source
     * @returns {string}
     */
    function live(t) {
        return t
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    }
    var code = live(src);

    /** @inner @param {string} hay @param {string} needle @returns {number} */
    function count(hay, needle) { return hay.split(needle).length - 1; }

    it('instrument control: the strip removes comments and keeps live code', function () {
        assert.equal(code.indexOf('#B243 — guards'), -1, 'a JSDoc-only phrase is gone');
        assert.ok(code.indexOf('var _deliver = function') > -1, 'live code survives');
        assert.ok(code.indexOf('conn._cluster.query(query, queryOptions)') > -1);
        assert.ok(code.length > src.length * 0.3, 'the strip does not blank the file');
    });

    it('the scope is resolved exactly once, inside a try whose catch is the boot terminal, before init()', function () {
        assert.equal(count(code, 'resolveScope('), 1, 'exactly one live call');
        var call = code.indexOf('resolveScope(infos.scope, process.env.NODE_SCOPE)');
        assert.ok(call > -1, 'called with the connector entry and NODE_SCOPE');
        var tryIdx = code.lastIndexOf('try {', call);
        assert.ok(tryIdx > -1 && call - tryIdx < 120, 'the call sits in a try');
        var catchIdx = code.indexOf('} catch (', call);
        var emerg = code.indexOf('console.emerg(', catchIdx);
        var fd2   = code.indexOf('fs.writeSync(2', emerg);
        var exit  = code.indexOf('process.exit(1)', fd2);
        var init  = code.indexOf('return init(conn, infos)', exit);
        assert.ok(catchIdx > call, 'catch follows the call');
        assert.ok(emerg > catchIdx && fd2 > emerg && exit > fd2, 'console.emerg → fs.writeSync(2 → process.exit(1), in that order');
        assert.ok(init > exit, 'init() runs only after the scope is resolved');
    });

    it('the unvalidated scope expression is gone from live code (still quoted in the comments)', function () {
        assert.equal(code.indexOf('infos.scope || process.env.NODE_SCOPE'), -1);
        assert.ok(src.indexOf('infos.scope || process.env.NODE_SCOPE') > -1, 'raw text still carries the needle');
    });

    it('both prototype stamps read the resolved scope', function () {
        assert.match(code, /Entity\.prototype\._scope\s*=\s*resolvedScope;/);
        assert.match(code, /entities\[entityName\]\.prototype\._scope\s*=\s*resolvedScope;/);
    });

    it('$scope is replaced with \\b and a function replacer over the resolved scope', function () {
        assert.ok(code.indexOf('query.replace(/\\$scope\\b/g, function () { return "\'" + resolvedScope + "\'"; })') > -1);
        assert.equal(code.indexOf('query.replace(/\\$scope/g, "'), -1, 'no string-replacement form remains');
    });

    it('the field-path guard runs after the gate and before the splice', function () {
        var gate  = code.indexOf('if ( re.test(qStr) ) {');
        var guard = code.indexOf('getInvalidFieldPathError(args[i], params[i], entityName, name, source)', gate);
        var cb    = code.indexOf('return _mainCallback(_fieldPathErr);', guard);
        var thr   = code.indexOf('throw _fieldPathErr;', cb);
        var splice = code.indexOf("qStr = qStr.replace(new RegExp('\\\\.'+ paramKeyEsc + '(?![0-9])', 'g')", thr);
        assert.ok(gate > -1, 'gate found');
        assert.ok(guard > gate, 'guard after the gate');
        assert.ok(cb > guard && thr > cb, 'callback first, then throw');
        assert.ok(splice > thr, 'the splice comes after the guard');
    });

    it('the SEARCH() substitution is gone from live code (kept, commented out, in the raw text)', function () {
        ['originalFtsClauses', 'searchValue', 'ftsClause', '(search\\(|search\\s+\\()'].forEach(function (n) {
            assert.equal(code.indexOf(n), -1, n + ' is gone from live code');
            assert.ok(src.indexOf(n) > -1, n + ' is still quoted in the comment');
        });
    });

    it('the dead SDK v2 copy of the SEARCH() block is removed', function () {
        assert.equal(src.indexOf('query.options.statement.match(/(search'), -1);
        // the needle's shape still matches the live-block copy kept as a comment
        assert.ok(src.indexOf('query.match(/(search\\(|search\\s+\\().*\\)/i)') > -1);
    });

    it('the bound parameters are still assigned before the dispatch', function () {
        var assign = code.indexOf('queryOptions.parameters = queryParams;');
        assert.ok(assign > -1);
        assert.ok(assign < code.indexOf('conn._cluster.query(query, queryOptions)'));
    });
});
