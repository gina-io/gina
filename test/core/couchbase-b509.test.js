'use strict';
/**
 * #B509 — a failed N1QL statement's RESULT ROWS no longer ride the synthesized
 * error's `.stack` / `.cause.http_body` into the consumer's log.
 *
 * The query service answers a failed statement with its WHOLE envelope, and
 * `results` is non-empty whenever the statement had already produced rows (a
 * `RETURNING` DML losing a CAS race, a SELECT timing out part-way). Both
 * couchbase onError sites (`register()` and `bulkInsert`) concatenated that
 * body verbatim into `error.stack` and kept it on `error.cause.http_body`, so
 * whatever printed the error — the controller's error path (`.stack`), or any
 * `console.error(err)` (`util.inspect` renders enumerable `cause`) — wrote the
 * application's own records into the log.
 *
 * Fix: `param-redact.redactResultRows()` replaces `results` with a row-count
 * marker, keeps every diagnostic field, fails CLOSED on a body it cannot parse,
 * and both sites shallow-copy `cause` so the SDK's object is never mutated.
 *
 * §01-§04 drive the helper. §05 pins BOTH sites on the raw source, with the
 * anti-vacuity third check (the raw text must still contain the token the
 * negative needle is built from). §06 lifts the shipped branch into a replica
 * and proves the sentinel row is gone from every channel while the diagnostic
 * fields and the classifier inputs survive; §06b is the subtract control — the
 * PRE-fix branch, which must still carry the row (so the sentinel is provably
 * detectable by this instrument).
 */
var test   = require('node:test');
var assert = require('node:assert');
var fs     = require('fs');
var path   = require('path');
var util   = require('util');

var FW        = require('../fw');
var CONNECTOR = path.join(FW, 'core/connectors/couchbase/index.js');
var src       = fs.readFileSync(CONNECTOR, 'utf8');
var redact    = require(path.join(FW, 'core/connectors/param-redact.js'));

// A token that appears in NO diagnostic field — only inside result rows.
var ROW = 'ROW_SENTINEL_9f2c';
var ENVELOPE = JSON.stringify({
    requestID : 'req-42',
    signature : { '*': '*' },
    results   : [ { id: 1, secret: ROW }, { id: 2, secret: ROW } ],
    errors    : [ { code: 12009, msg: 'CAS mismatch' } ],
    status    : 'errors',
    metrics   : { resultCount: 2 }
});

function count(hay, needle) { return hay.split(needle).length - 1; }

// ── the helper ──────────────────────────────────────────────────────────────
test('#B509 §01 redactResultRows replaces `results` with a row-count marker and keeps every diagnostic field', function () {
    var out = redact.redactResultRows(ENVELOPE);
    assert.strictEqual(typeof out, 'string');
    assert.strictEqual(out.indexOf(ROW), -1, 'no row content survives');
    var o = JSON.parse(out);
    assert.strictEqual(o.results, '[2 result rows redacted]');
    assert.strictEqual(o.requestID, 'req-42');
    assert.deepStrictEqual(o.errors, [ { code: 12009, msg: 'CAS mismatch' } ]);
    assert.strictEqual(o.status, 'errors');
    assert.deepStrictEqual(o.signature, { '*': '*' });
    assert.deepStrictEqual(o.metrics, { resultCount: 2 });
});

test('#B509 §02 an empty `results` reads 0 rows; an absent `results` leaves the envelope content untouched', function () {
    var empty = JSON.parse(redact.redactResultRows(JSON.stringify({ requestID: 'r', results: [], errors: [ { code: 1080 } ] })));
    assert.strictEqual(empty.results, '[0 result rows redacted]');
    assert.deepStrictEqual(empty.errors, [ { code: 1080 } ]);
    var body = JSON.stringify({ requestID: 'r', errors: [ { code: 1080, msg: 'Timeout' } ] });
    assert.deepStrictEqual(JSON.parse(redact.redactResultRows(body)), JSON.parse(body), 'nothing to redact ⇒ same content');
    assert.strictEqual(JSON.parse(redact.redactResultRows(JSON.stringify({ results: [ { secret: ROW } ] }))).results,
        '[1 result row redacted]', 'singular for one row');
});

test('#B509 §03 fail-closed: a body the helper cannot parse is dropped, never forwarded — and it never throws', function () {
    var garbled = '{"results":[{"secret":"' + ROW + '"}]'; // truncated JSON carrying a row
    var out = redact.redactResultRows(garbled);
    assert.strictEqual(out.indexOf(ROW), -1, 'not one byte of an unparseable body is forwarded');
    assert.match(out, /^\[unparseable query envelope, \d+ B redacted\]$/);
    assert.match(redact.redactResultRows('[1,2]'), /^\[non-object query envelope, \d+ B redacted\]$/);
    assert.match(redact.redactResultRows('null'),  /^\[non-object query envelope, \d+ B redacted\]$/);
    [ undefined, null, 42, {}, { http_body: ROW } ].forEach(function (v) {
        var r;
        assert.doesNotThrow(function () { r = redact.redactResultRows(v); });
        assert.strictEqual(typeof r, 'string');
        assert.strictEqual(r.indexOf(ROW), -1);
        assert.match(r, /^\[query envelope of type \w+ redacted\]$/);
    });
});

test('#B509 §04 a non-array `results` is redacted as one opaque value, and a `__proto__` key in the body is inert', function () {
    var o = JSON.parse(redact.redactResultRows(JSON.stringify({ results: { secret: ROW } })));
    assert.strictEqual(o.results, '[1 result row redacted]');
    var polluted = '{"__proto__":{"polluted":true},"results":[{"secret":"' + ROW + '"}]}';
    var out = redact.redactResultRows(polluted);
    assert.strictEqual(out.indexOf(ROW), -1);
    assert.strictEqual(({}).polluted, undefined, 'JSON.parse never installs a prototype; nothing else is merged');
});

// ── the two sites, pinned on the raw source ─────────────────────────────────
test('#B509 §05 BOTH onError sites route the envelope through the helper and shallow-copy cause; the raw concatenation is gone', function () {
    assert.strictEqual(count(src, 'paramRedact.redactResultRows(err.cause.http_body)'), 2, 'register() + bulkInsert call the helper');
    assert.strictEqual(count(src, 'Object.assign({}, err.cause, { http_body: _redactedBody })'), 2, 'both sites copy cause with the redacted body');
    assert.strictEqual(count(src, "+ err.cause.http_body"), 0, 'no site concatenates the raw body any more');
    // anti-vacuity: the negative needle is built from a token the raw text MUST still contain,
    // so a broken strip (or a wrong file) cannot pass this pin by reading empty
    assert.ok(count(src, 'http_body') >= 4, 'the raw source still names http_body (control for the 0 above)');
    // the #B153 residual guard is untouched at both sites
    assert.strictEqual(count(src, "typeof(err.cause.first_error_message) != 'undefined' && err.cause.first_error_message !== ''"), 2);
});

// ── the shipped branch, lifted into a replica ───────────────────────────────
/**
 * The FIXED branch as it ships at both sites (the `if` arm only — the #B153
 * else-arm is pinned by couchbase-connector.test.js §08).
 * @param {object} err
 * @param {string} trigger
 * @returns {Error}
 */
function fixedBranch(err, trigger) {
    var error = new Error(err.cause.first_error_message);
    var _redactedBody = redact.redactResultRows(err.cause.http_body);
    error.stack = trigger + '\n' + _redactedBody;
    error.cause = Object.assign({}, err.cause, { http_body: _redactedBody });
    return error;
}
/** The PRE-fix branch — the subtract control. */
function oldBranch(err, trigger) {
    var error = new Error(err.cause.first_error_message);
    error.stack = trigger + '\n' + err.cause.http_body;
    error.cause = err.cause;
    return error;
}
function sdkError() {
    return { cause: { first_error_code: 12009, first_error_message: 'CAS mismatch', retry: false, http_body: ENVELOPE } };
}

test('#B509 §06 the synthesized error carries no row on ANY channel, keeps the diagnostics and the classifier inputs, and leaves the SDK object alone', function () {
    var err   = sdkError();
    var error = fixedBranch(err, 'entity#method');
    // channel 1 — the stack the controller error path prints
    assert.ok(error.stack.indexOf('entity#method\n') === 0, 'trigger first');
    assert.strictEqual(error.stack.indexOf(ROW), -1, 'no row on .stack');
    assert.ok(error.stack.indexOf('12009') > -1 && error.stack.indexOf('req-42') > -1, 'code + requestID kept on .stack');
    // channel 2 — the cause any console.error(err) renders through util.inspect
    assert.strictEqual(error.cause.http_body.indexOf(ROW), -1, 'no row on .cause.http_body');
    var inspected = util.inspect(error, { depth: 4 });
    assert.strictEqual(inspected.indexOf(ROW), -1, 'no row through util.inspect (console.error(err))');
    assert.ok(inspected.indexOf('req-42') > -1, 'diagnostics still visible through util.inspect');
    // classifier inputs (connector-error reads exactly these two) + message
    assert.strictEqual(error.cause.first_error_code, 12009);
    assert.strictEqual(error.cause.retry, false);
    assert.strictEqual(error.cause.first_error_message, 'CAS mismatch');
    assert.strictEqual(error.message, 'CAS mismatch');
    // the SDK's object is copied, not mutated
    assert.notStrictEqual(error.cause, err.cause);
    assert.ok(err.cause.http_body.indexOf(ROW) > -1, 'the SDK object still holds its original body');
});

test('#B509 §06b subtract control: the PRE-fix branch DOES carry the row on both channels (the sentinel is detectable)', function () {
    var error = oldBranch(sdkError(), 'entity#method');
    assert.ok(error.stack.indexOf(ROW) > -1, 'pre-fix .stack carries the row');
    assert.ok(util.inspect(error, { depth: 4 }).indexOf(ROW) > -1, 'pre-fix util.inspect carries the row');
});
