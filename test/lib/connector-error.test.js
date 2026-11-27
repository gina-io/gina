'use strict';
/**
 * #CE1 — Connector error classification (lib/connector-error).
 *
 * The classifier normalizes the transient-vs-permanent signal every datastore
 * driver already carries (socket errno, driver codes/names, ANSI SQLSTATE,
 * MongoDB error labels, Couchbase N1QL cause codes) into two fields stamped on
 * the error that flows to the controller: `err.isTransient` + `err.transientReason`.
 *
 * Strategy:
 *  - §01/§02 drive the REAL module: every transient family classifies true with
 *    the documented reason token, and a battery of KNOWN-PERMANENT errors (incl.
 *    ENOTFOUND, duplicate-key, plain permanent SQLSTATE) classifies false — the
 *    negative control proving the instrument discriminates rather than always
 *    returning transient.
 *  - §03 proves totality: exotic / hostile error shapes never make classify throw.
 *  - §04 exercises stamp(): in-place, additive, idempotent, non-object safe,
 *    frozen-object safe.
 *  - §05 pins the wiring: all seven datastore connectors stamp at their error
 *    sites, and lib/index.js registers the module via a plain require.
 *
 * Usage: node --test test/lib/connector-error.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');
var ce = require(path.join(FW, 'lib/connector-error/src/main.js'));


describe('#CE1 §01 — classify: transient families', function () {

    var transientCases = [
        // socket errno
        ['socket ECONNREFUSED',   { code: 'ECONNREFUSED' },          'socket:econnrefused'],
        ['socket ECONNRESET',     { code: 'ECONNRESET' },            'socket:econnreset'],
        ['socket ETIMEDOUT',      { code: 'ETIMEDOUT' },             'socket:etimedout'],
        ['socket EPIPE',          { code: 'EPIPE' },                 'socket:epipe'],
        ['socket EAI_AGAIN',      { code: 'EAI_AGAIN' },             'socket:eai_again'],
        ['errno-only string',     { errno: 'ECONNRESET' },           'socket:econnreset'],
        // mysql / mariadb
        ['mysql conn lost',       { code: 'PROTOCOL_CONNECTION_LOST' }, 'mysql:connection-lost'],
        ['mysql deadlock',        { code: 'ER_LOCK_DEADLOCK' },      'mysql:deadlock'],
        ['mysql lock wait',       { code: 'ER_LOCK_WAIT_TIMEOUT' },  'mysql:lock-wait-timeout'],
        ['mysql too many conn',   { code: 'ER_CON_COUNT_ERROR' },    'mysql:too-many-connections'],
        // sqlite — string-code form (better-sqlite3 style)
        ['sqlite busy',           { code: 'SQLITE_BUSY' },           'sqlite:busy'],
        ['sqlite locked',         { code: 'SQLITE_LOCKED' },         'sqlite:locked'],
        // sqlite — node:sqlite numeric errcode form (the connector's ACTUAL
        // driver; MEASURED shape: code ERR_SQLITE_ERROR + errcode, never
        // code SQLITE_BUSY)
        ['node:sqlite busy (measured shape)',
            { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' }, 'sqlite:busy'],
        ['node:sqlite locked errcode 6',    { errcode: 6 },          'sqlite:locked'],
        ['node:sqlite BUSY_RECOVERY 261 (extended -> primary 5)',
            { errcode: 261 },                                        'sqlite:busy'],
        // postgres SQLSTATE
        ['pg serialization',      { code: '40001' },                 'postgres:serialization-failure'],
        ['pg deadlock',           { code: '40P01' },                 'postgres:deadlock'],
        ['pg cannot connect now', { code: '57P03' },                 'postgres:cannot-connect-now'],
        ['pg too many conn',      { code: '53300' },                 'postgres:too-many-connections'],
        ['pg 08 conn class',      { code: '08006' },                 'postgres:connection-exception'],
        ['pg 08000 conn class',   { code: '08000' },                 'postgres:connection-exception'],
        // cassandra / scylladb (by name)
        ['scylla no host',        { name: 'NoHostAvailableError' },  'cassandra:no-host-available'],
        ['scylla op timed out',   { name: 'OperationTimedOutError' },'cassandra:operation-timed-out'],
        // couchbase (by name)
        ['couchbase timeout',     { name: 'UnambiguousTimeoutError' },'couchbase:timeout'],
        ['couchbase svc unavail', { name: 'ServiceNotAvailableError' },'couchbase:service-unavailable'],
        // couchbase N1QL cause envelope (preserved by #B153)
        ['couchbase N1QL 1080',   { cause: { first_error_code: 1080 } }, 'couchbase:timeout'],
        ['couchbase cause retry', { cause: { retry: true } },        'couchbase:retryable'],
        ['couchbase N1QL 12008 bulk-get retry exhaustion',
            { cause: { first_error_code: 12008 } },              'couchbase:bulk-get-retry-exhausted'],
        // the #B153 envelope forward reaches classify as a synthesized Error —
        // name is 'Error' (no signal), only the cause code can discriminate
        ['couchbase 12008 via the envelope-forward shape (synthesized Error)',
            (function () {
                var e = new Error('bulk get exceeded 8 attempts');
                e.cause = { first_error_code: 12008, http_body: '{}' };
                return e;
            })(),                                                'couchbase:bulk-get-retry-exhausted'],
        ['couchbase 12008 with the server retry flag (the code entry names the reason)',
            { cause: { first_error_code: 12008, retry: true } }, 'couchbase:bulk-get-retry-exhausted'],
        // mongodb error label
        ['mongo transient txn',   { hasErrorLabel: function (l) { return l === 'TransientTransactionError'; } }, 'mongo:transient-transaction'],
        ['mongo retryable write', { hasErrorLabel: function (l) { return l === 'RetryableWriteError'; } },      'mongo:retryable-write'],
        // mongodb numeric server codes
        ['mongo 11600 shutdown',  { code: 11600 },                   'mongo:interrupted-at-shutdown'],
        ['mongo 189 stepped down',{ code: 189 },                     'mongo:primary-stepped-down'],
        // mongodb network error by name
        ['mongo network',         { name: 'MongoNetworkError' },     'mongo:network']
    ];

    transientCases.forEach(function (c) {
        it(c[0] + ' -> transient (' + c[2] + ')', function () {
            var r = ce.classify(c[1]);
            assert.equal(r.isTransient, true, c[0] + ' must be transient');
            assert.equal(r.reason, c[2], 'reason token');
        });
    });
});


describe('#CE1 §02 — classify: permanent (the discriminating negative control)', function () {

    var permanentCases = [
        ['ENOTFOUND (DNS misconfig, NOT transient)', { code: 'ENOTFOUND' }],
        ['mysql duplicate entry',                    { code: 'ER_DUP_ENTRY' }],
        ['mysql bad field',                          { code: 'ER_BAD_FIELD_ERROR' }],
        ['pg unique_violation 23505',                { code: '23505' }],
        ['pg syntax_error 42601',                    { code: '42601' }],
        ['pg undefined_table 42P01',                 { code: '42P01' }],
        ['mongo duplicate key 11000',                { code: 11000 }],
        ['mongo validation 121',                     { code: 121 }],
        ['unknown driver code',                      { code: 'SOMETHING_ELSE' }],
        ['a plain Error with a message only',        new Error('boom')],
        ['a name not in the transient set',          { name: 'MongoServerError' }],
        ['a cause with a permanent N1QL code',       { cause: { first_error_code: 3000 } }],
        ['N1QL 12009 generic DML (covers duplicate-key — deliberately permanent)',
                                                     { cause: { first_error_code: 12009 } }],
        ['N1QL 12003 keyspace not found (shares the SDK IndexFailureError bucket with 12008 — the code, not the class, discriminates)',
                                                     { cause: { first_error_code: 12003 } }],
        ['mongo code 7 HostNotFound (the server-side ENOTFOUND — deliberately permanent)',
                                                     { code: 7 }],
        ['node:sqlite constraint errcode 1555 (measured dup-key control)',
                                                     { code: 'ERR_SQLITE_ERROR', errcode: 1555, errstr: 'constraint failed' }],
        ['node:sqlite generic error errcode 1',      { errcode: 1 }],
        ['null',                                     null],
        ['undefined',                                undefined],
        ['a string',                                 'not an error'],
        ['a number',                                 42],
        ['an empty object',                          {}]
    ];

    permanentCases.forEach(function (c) {
        it(c[0] + ' -> permanent', function () {
            var r = ce.classify(c[1]);
            assert.equal(r.isTransient, false, c[0] + ' must be permanent');
            assert.equal(r.reason, null, 'reason is null for permanent');
        });
    });

    it('the pg 08-class match requires a full 5-char SQLSTATE (short "08" does not match)', function () {
        assert.equal(ce.classify({ code: '08' }).isTransient, false, 'a 2-char code is not a SQLSTATE');
        assert.equal(ce.classify({ code: '0800' }).isTransient, false, '4-char is not a SQLSTATE');
        assert.equal(ce.classify({ code: '08006' }).isTransient, true, 'the real 5-char 08006 IS transient');
    });
});


describe('#CE1 §03 — classify is total (never throws on hostile shapes)', function () {

    it('an error whose `code` getter throws classifies as permanent, not a crash', function () {
        var hostile = {};
        Object.defineProperty(hostile, 'code', { get: function () { throw new Error('nope'); } });
        var r;
        assert.doesNotThrow(function () { r = ce.classify(hostile); });
        assert.equal(r.isTransient, false);
    });

    it('a frozen error object classifies without throwing', function () {
        var frozen = Object.freeze({ code: 'ECONNREFUSED' });
        var r;
        assert.doesNotThrow(function () { r = ce.classify(frozen); });
        assert.equal(r.isTransient, true, 'a frozen object is still readable');
    });

    it('an error whose hasErrorLabel throws classifies as permanent', function () {
        var r;
        assert.doesNotThrow(function () { r = ce.classify({ hasErrorLabel: function () { throw new Error('x'); } }); });
        assert.equal(r.isTransient, false);
    });
});


describe('#CE1 §04 — stamp: in-place, additive, idempotent, safe', function () {

    it('stamps isTransient + transientReason on the error and returns it', function () {
        var e = new Error('connection reset');
        e.code = 'ECONNRESET';
        var returned = ce.stamp(e);
        assert.equal(returned, e, 'returns the same error for chaining');
        assert.equal(e.isTransient, true);
        assert.equal(e.transientReason, 'socket:econnreset');
    });

    it('stamps a permanent error explicitly false / null (not left undefined)', function () {
        var e = new Error('dup'); e.code = 'ER_DUP_ENTRY';
        ce.stamp(e);
        assert.equal(e.isTransient, false, 'explicit false documents "classified, permanent"');
        assert.equal(e.transientReason, null);
    });

    it('preserves the existing error fields (additive only)', function () {
        var e = new Error('boom'); e.code = 'ETIMEDOUT'; e.stack = 'STACK'; e.status = 500;
        ce.stamp(e);
        assert.equal(e.message, 'boom');
        assert.equal(e.code, 'ETIMEDOUT');
        assert.equal(e.stack, 'STACK');
        assert.equal(e.status, 500, 'a pre-set status is untouched');
    });

    it('is idempotent (re-stamping yields the same result)', function () {
        var e = new Error('x'); e.code = 'SQLITE_BUSY';
        ce.stamp(e); ce.stamp(e);
        assert.equal(e.isTransient, true);
        assert.equal(e.transientReason, 'sqlite:busy');
    });

    it('is a no-op on non-object inputs (returns them, no throw)', function () {
        assert.equal(ce.stamp(null), null);
        assert.equal(ce.stamp(undefined), undefined);
        assert.equal(ce.stamp('str'), 'str');
    });

    it('does not throw on a frozen error (leaves it unstamped)', function () {
        var frozen = Object.freeze(new Error('x'));
        assert.doesNotThrow(function () { ce.stamp(frozen); });
    });
});


describe('#CE1 §05 — wiring: every connector stamps, and lib registers the module', function () {

    var CONN = path.join(FW, 'core/connectors');

    // each connector reject/callback error site carries the stamp (2 per connector)
    var expected = {
        'mongodb'    : { needle: 'lib.connectorError.stamp(err)',   count: 2 },
        'mysql'      : { needle: 'lib.connectorError.stamp(err)',   count: 2 },
        'postgresql' : { needle: 'lib.connectorError.stamp(err)',   count: 2 },
        'duckdb'     : { needle: 'lib.connectorError.stamp(err)',   count: 2 },
        'scylladb'   : { needle: 'lib.connectorError.stamp(err)',   count: 2 },
        'sqlite'     : { needle: 'lib.connectorError.stamp(e)',     count: 2 },
        'couchbase'  : { needle: 'lib.connectorError.stamp',        count: 4 }
    };

    Object.keys(expected).forEach(function (name) {
        it(name + ' stamps at ' + expected[name].count + ' error site(s)', function () {
            var src = fs.readFileSync(path.join(CONN, name, 'index.js'), 'utf8');
            var n = src.split(expected[name].needle).length - 1;
            assert.equal(n, expected[name].count, name + ' stamp count');
        });
    });

    it('lib/index.js registers connectorError via a PLAIN require (not _require)', function () {
        var src = fs.readFileSync(path.join(FW, 'lib/index.js'), 'utf8');
        assert.match(src, /connectorError\s*:\s*require\('\.\/connector-error'\)/,
            'plain require — a _require copy would be a #B32-residual leak candidate');
        assert.doesNotMatch(src, /connectorError\s*:\s*_require/, 'must not be _require');
    });

    it('the couchbase stamp sits inside the onQueryCallback if(err) block AND the bulkInsert emit path', function () {
        var src = fs.readFileSync(path.join(CONN, 'couchbase', 'index.js'), 'utf8');
        assert.match(src, /if \(err\) \{\s*lib\.connectorError\.stamp\(err\);/,
            'stamps err once at the top of the if(err) block (covers every downstream emit/callback)');
        // #B429 — bulkInsert now stamps ONCE into a local and carries it into both the
        // per-call settlement and the observability emit (it previously stamped twice).
        assert.match(src, /error = lib\.connectorError\.stamp\(error\);[\s\S]{0,200}?self\.emit\(trigger, error\)/,
            'the bulkInsert error is stamped on the path that settles and emits it');
    });
});
