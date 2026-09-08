'use strict';
/**
 * Couchbase connector — public SDK Cluster accessor & shared cluster resolver
 *
 * Strategy: source inspection + pure-logic replicas.
 * No live Couchbase cluster (or installed driver) is required — the connector
 * `require`s the project-provided `couchbase` module at load time, so these
 * tests read the source as text and replicate the resolver logic line-for-line.
 *
 * Feature: the connector exposes a public, non-underscore `getCluster()` on its
 * entities so consumers can reach SDK-level features the entity layer does not
 * wrap (e.g. multi-document transactions) without coupling to private `_*`
 * internals. The dual-shape cluster lookup (`conn._cluster` vs
 * `conn._scope._bucket._cluster`) is factored into a single internal
 * `resolveCluster()` helper consumed by `explainForIndexes`, `bulkInsert` and
 * `getCluster()`.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW        = require('../fw');
var CONNECTOR = path.join(FW, 'core/connectors/couchbase/index.js');
// #B153 residual (§08b): the real classifier, so the end-to-end replicas assert
// the CLASSIFICATION outcome rather than merely the forwarded error shape.
var ce        = require(path.join(FW, 'lib/connector-error/src/main.js'));
// #B509 — the result-row redaction the FIXED replica (§08) now routes through,
// realigned with the shipped site.
var paramRedact = require(path.join(FW, 'core/connectors/param-redact.js'));


// ─── 01 — shared resolveCluster() helper present, dual-shape, named throw ────

describe('01 - resolveCluster: shared dual-shape helper (source pins)', function() {

    var src, body;
    before(function() {
        src  = fs.readFileSync(CONNECTOR, 'utf8');
        // isolate the helper body: from its declaration to the next top-level `var ` def
        var start = src.indexOf('var resolveCluster = function(conn) {');
        var rest  = src.slice(start + 1);
        var end   = rest.indexOf('\n    var ');
        body      = src.slice(start, end > -1 ? start + 1 + end : src.length);
    });

    it('declares the resolveCluster helper', function() {
        assert.ok(
            src.indexOf('var resolveCluster = function(conn) {') > -1,
            'expected a single shared resolveCluster(conn) helper'
        );
    });

    it('checks the top-level shape conn._cluster', function() {
        assert.ok(/conn\._cluster/.test(body), 'resolveCluster must check conn._cluster');
    });

    it('checks the nested shape conn._scope._bucket._cluster', function() {
        assert.ok(
            /conn\._scope\s*&&\s*conn\._scope\._bucket\s*&&\s*conn\._scope\._bucket\._cluster/.test(body),
            'resolveCluster must fall back to conn._scope._bucket._cluster with a defensive chain'
        );
    });

    it('guards that the resolved cluster exposes query()', function() {
        assert.ok(
            /typeof\(cluster\.query\)\s*!==\s*'function'/.test(body),
            'resolveCluster must reject a handle without a query() method'
        );
    });

    it('throws a clearly-coded error when neither shape resolves', function() {
        assert.ok(/GINA_COUCHBASE_CLUSTER_UNRESOLVED/.test(body), 'expected GINA_COUCHBASE_CLUSTER_UNRESOLVED code on the throw');
        assert.ok(/throw _err;/.test(body), 'resolveCluster must throw on unresolved cluster');
    });

});


// ─── 02 — explainForIndexes & bulkInsert consume the shared helper ──────────

describe('02 - consumers route through resolveCluster (source pins)', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR, 'utf8'); });

    it('explainForIndexes resolves via resolveCluster, non-fatally', function() {
        var start = src.indexOf('var explainForIndexes = function');
        var rest  = src.slice(start + 1);
        var end   = rest.indexOf('\n    var ');
        var fn    = src.slice(start, end > -1 ? start + 1 + end : src.length);
        assert.ok(/cluster\s*=\s*resolveCluster\(conn\)/.test(fn), 'explainForIndexes must call resolveCluster(conn)');
        assert.ok(/catch\s*\(_clusterErr\)/.test(fn), 'explainForIndexes must keep resolution non-fatal (try/catch + warn + return)');
        assert.ok(/return;/.test(fn), 'explainForIndexes must skip (return) on a resolution failure');
    });

    it('bulkInsert queries via resolveCluster(conn).query(...)', function() {
        assert.ok(
            src.indexOf('resolveCluster(conn).query(query, queryOptions)') > -1,
            'bulkInsert must query through the shared resolver'
        );
    });

    it('bulkInsert no longer derefs the bare nested shape at the call site', function() {
        assert.ok(
            src.indexOf('conn._scope._bucket._cluster.query(query, queryOptions)') === -1,
            'the bare conn._scope._bucket._cluster.query(...) call site must be gone (replaced by resolveCluster)'
        );
    });

});


// ─── 03 — public getCluster() accessor present and wired onto entities ──────

describe('03 - getCluster: public accessor wired onto entity surfaces (source pins)', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR, 'utf8'); });

    it('defines getCluster delegating to getConnection + resolveCluster', function() {
        assert.ok(src.indexOf('var getCluster = function() {') > -1, 'expected a getCluster accessor');
        assert.ok(
            /return resolveCluster\(this\.getConnection\(\)\);/.test(src),
            'getCluster must resolve the cluster from this.getConnection()'
        );
    });

    it('is decorated onto model entities (alongside bulkInsert)', function() {
        assert.ok(
            /Entity\.prototype\.getCluster\s*=\s*getCluster;/.test(src),
            'model entities must expose getCluster'
        );
    });

    it('is decorated onto N1QL entities (parity, no asymmetric undefined)', function() {
        assert.ok(
            /entities\[entityName\]\.prototype\.getCluster\s*=\s*getCluster;/.test(src),
            'N1QL entities must expose getCluster for parity'
        );
    });

    it('documents that transaction support depends on the project-provided driver', function() {
        var start = src.indexOf('* getCluster');
        var fn    = src.slice(start, start + 1400);
        assert.ok(/transactions\(\)\.run/.test(fn), 'JSDoc should show the transactions().run use case');
        assert.ok(/3\.2\+\s*\/\s*4\.x/.test(fn), 'JSDoc must note the SDK version dependence (3.2+ / 4.x)');
    });

});


// ─── 04 — pure-logic replica: resolveCluster behaviour ──────────────────────

describe('04 - resolveCluster behaviour (pure-logic replica)', function() {

    // Mirrors framework/v*/core/connectors/couchbase/index.js resolveCluster()
    // line-for-line. Kept in lockstep with the source pins in §01.
    function resolveCluster(conn) {
        var cluster = (conn && conn._cluster)
            ? conn._cluster
            : (conn && conn._scope && conn._scope._bucket && conn._scope._bucket._cluster)
                ? conn._scope._bucket._cluster
                : null;

        if (!cluster || typeof(cluster.query) !== 'function') {
            var _err = new Error('[ CONNECTOR ][ couchbase ] Unable to resolve the SDK Cluster from the connection.');
            _err.code = 'GINA_COUCHBASE_CLUSTER_UNRESOLVED';
            throw _err;
        }

        return cluster;
    }

    var clusterStub = { query: function() {} };

    it('returns the cluster on the legacy top-level shape (conn._cluster)', function() {
        var conn = { _cluster: clusterStub };
        assert.equal(resolveCluster(conn), clusterStub);
    });

    it('returns the cluster on the nested shape (conn._scope._bucket._cluster)', function() {
        var conn = { _scope: { _bucket: { _cluster: clusterStub } } };
        assert.equal(resolveCluster(conn), clusterStub);
    });

    it('prefers the top-level shape when both are present', function() {
        var top    = { query: function() {} };
        var nested = { query: function() {} };
        var conn   = { _cluster: top, _scope: { _bucket: { _cluster: nested } } };
        assert.equal(resolveCluster(conn), top);
    });

    it('throws GINA_COUCHBASE_CLUSTER_UNRESOLVED when neither shape resolves', function() {
        assert.throws(
            function() { resolveCluster({}); },
            function(err) { return err.code === 'GINA_COUCHBASE_CLUSTER_UNRESOLVED'; },
            'an empty conn must throw the named error'
        );
    });

    it('throws on a null/undefined connection', function() {
        assert.throws(function() { resolveCluster(null); },      function(e) { return e.code === 'GINA_COUCHBASE_CLUSTER_UNRESOLVED'; });
        assert.throws(function() { resolveCluster(undefined); }, function(e) { return e.code === 'GINA_COUCHBASE_CLUSTER_UNRESOLVED'; });
    });

    it('throws when a resolved handle has no query() method', function() {
        assert.throws(
            function() { resolveCluster({ _cluster: {} }); },
            function(err) { return err.code === 'GINA_COUCHBASE_CLUSTER_UNRESOLVED'; },
            'a cluster handle without query() is not usable'
        );
    });

});


// ─── 05 — pure-logic replica: getCluster delegates correctly ────────────────

describe('05 - getCluster delegation (pure-logic replica)', function() {

    function resolveCluster(conn) {
        var cluster = (conn && conn._cluster)
            ? conn._cluster
            : (conn && conn._scope && conn._scope._bucket && conn._scope._bucket._cluster)
                ? conn._scope._bucket._cluster
                : null;
        if (!cluster || typeof(cluster.query) !== 'function') {
            var _err = new Error('unresolved');
            _err.code = 'GINA_COUCHBASE_CLUSTER_UNRESOLVED';
            throw _err;
        }
        return cluster;
    }

    // Mirrors: var getCluster = function() { return resolveCluster(this.getConnection()); };
    function getCluster() { return resolveCluster(this.getConnection()); }

    var clusterStub = { query: function() {} };

    it('returns the cluster from a bucket-shaped getConnection()', function() {
        var entity = { getConnection: function() { return { _cluster: clusterStub }; }, getCluster: getCluster };
        assert.equal(entity.getCluster(), clusterStub);
    });

    it('returns the cluster from a scope-shaped getConnection()', function() {
        var entity = {
            getConnection: function() { return { _scope: { _bucket: { _cluster: clusterStub } } }; },
            getCluster: getCluster
        };
        assert.equal(entity.getCluster(), clusterStub);
    });

    it('propagates the named error when the connection yields no cluster', function() {
        var entity = { getConnection: function() { return {}; }, getCluster: getCluster };
        assert.throws(
            function() { entity.getCluster(); },
            function(err) { return err.code === 'GINA_COUCHBASE_CLUSTER_UNRESOLVED'; }
        );
    });

});


// ─── 06 — dynamic field-path $N substituted at EVERY occurrence (source pins) ─

describe('06 - field-path $N substitution: every occurrence (source pins)', function() {

    var blk, code;
    before(function() {
        var src = fs.readFileSync(CONNECTOR, 'utf8');
        // isolate the foundSpecialLeftCase substitution loop
        var start = src.indexOf('if (foundSpecialLeftCase) {');
        var rest  = src.slice(start);
        var end   = rest.indexOf('if ( sdkVersion == 3 )');
        blk  = end > -1 ? rest.slice(0, end) : rest;
        // strip comments before negative pins: the explanatory comment in the block
        // intentionally names the old greedy `(.*)` shape it replaced, which would
        // otherwise trip the "(.*) is gone" pin (jsdoc.md negative-pin-vs-comment trap).
        code = blk.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    });

    it('escapes the placeholder once into a reusable paramKeyEsc', function() {
        assert.ok(
            code.indexOf('var paramKeyEsc = params[i].replace(') > -1,
            'expected a single paramKeyEsc = params[i].replace(/([$%]+)/, ...) extraction'
        );
    });

    it('gates field-path position with a leading dot + digit boundary (no greedy prefix)', function() {
        assert.ok(
            code.indexOf("paramKeyEsc + '(?![0-9])');") > -1,
            "gate regex must be /\\.<key>(?![0-9])/ — leading dot + digit boundary, no greedy (.*) prefix"
        );
    });

    it('rewrites EVERY occurrence: global (g) flag + dollar-safe function replacer', function() {
        assert.ok(
            code.indexOf("paramKeyEsc + '(?![0-9])', 'g')") > -1,
            'replace must carry the global (g) flag so all field-path occurrences are rewritten'
        );
        assert.ok(
            code.indexOf("function () { return '.' + args[i]; }") > -1,
            'replace must use a function replacer (dollar-safe), never a string replacement that would expand $&/$`/$\''
        );
    });

    it('keeps the digit boundary on BOTH the gate and the replace', function() {
        var n = (code.match(/\(\?!\[0-9\]\)/g) || []).length;
        assert.ok(n >= 2, 'expected (?![0-9]) on both the gate and the global replace; found ' + n);
    });

    it('removed the greedy (.*) prefix capture and the $1 re-emit (defect gone)', function() {
        assert.ok(code.indexOf('(.*)') === -1, 'the greedy (.*) prefix capture must be gone from the substitution');
        assert.ok(code.indexOf("'$1\\.'+args[i]") === -1, "the old '$1.'+args[i] greedy re-emit replacement must be gone");
    });

});


// ─── 07 — dynamic field-path $N substitution behaviour (pure-logic replica) ──

describe('07 - field-path $N substitution behaviour (pure-logic replica)', function() {

    // Mirrors the foundSpecialLeftCase loop in
    // framework/v*\/core/connectors/couchbase/index.js line-for-line (post-fix).
    function substitute(body, params, inlineParams, args) {
        var qStr = body.slice(0), inl = inlineParams.slice(), re = null, key, i, len;
        var foundSpecialLeftCase = /\w+\.(\$|\%)/.test(qStr);
        if (foundSpecialLeftCase) {
            i = 0; len = args.length;
            for (; i < len; ++i) {
                key = inl.indexOf(params[i]);
                if (key > -1) {
                    var paramKeyEsc = params[i].replace(/([$%]+)/, '\\$1');
                    re = new RegExp('\\.' + paramKeyEsc + '(?![0-9])');
                    if (re.test(qStr)) {
                        qStr = qStr.replace(new RegExp('\\.' + paramKeyEsc + '(?![0-9])', 'g'), function () { return '.' + args[i]; });
                        inl.splice(key, 1);
                    }
                }
            }
        }
        return qStr;
    }

    // inlineParams mirrors index.js:436-443 (deduped $N from the body, order of first use).
    function inlineParamsOf(body) { return Array.from(new Set(body.match(/\$\w+/g))); }

    it('substitutes the SAME $N field-path key in BOTH a SET and a WHERE (the reported bug)', function() {
        var body = 'UPDATE bucket AS d SET d.flags.$2 = $3 WHERE d.id = $1 AND d.flags.$2 IS MISSING RETURNING d.id;';
        var out  = substitute(body, ['$1', '$2', '$3'], inlineParamsOf(body), ['doc-1', 'seen', true]);
        assert.equal(out, 'UPDATE bucket AS d SET d.flags.seen = $3 WHERE d.id = $1 AND d.flags.seen IS MISSING RETURNING d.id;');
        assert.doesNotMatch(out, /\.\$\d+/, 'no literal .$N field-path placeholder may survive');
    });

    it('mixes a field-path $N with value params: field-path interpolated, values stay positional', function() {
        var body = 'UPDATE bucket AS d SET d.counters.$2 = $3 WHERE d.id = $1 RETURNING d.id;';
        var out  = substitute(body, ['$1', '$2', '$3'], inlineParamsOf(body), ['doc-1', 'hits', 5]);
        assert.equal(out, 'UPDATE bucket AS d SET d.counters.hits = $3 WHERE d.id = $1 RETURNING d.id;');
        assert.match(out, /= \$3 /,       'value param $3 must remain positional (not interpolated)');
        assert.match(out, /d\.id = \$1 /, 'value param $1 must remain positional (not interpolated)');
    });

    it('keeps two DISTINCT field-path params (each used once) working', function() {
        var body = 'UPDATE bucket AS d SET d.a.$2 = 1, d.b.$3 = 2 WHERE d.id = $1 RETURNING d.id;';
        var out  = substitute(body, ['$1', '$2', '$3'], inlineParamsOf(body), ['doc-1', 'alpha', 'beta']);
        assert.equal(out, 'UPDATE bucket AS d SET d.a.alpha = 1, d.b.beta = 2 WHERE d.id = $1 RETURNING d.id;');
    });

    it('respects the digit boundary: $3 does not substitute inside $30', function() {
        var body = 'UPDATE bucket AS d SET d.x.$3 = 1, d.y.$30 = 2 WHERE d.id = $1 RETURNING d.id;';
        // comment order forces $3 to be processed before $30; both are field-path keys
        var out  = substitute(body, ['$1', '$3', '$30'], inlineParamsOf(body), ['doc-1', 'K3', 'K30']);
        assert.equal(out, 'UPDATE bucket AS d SET d.x.K3 = 1, d.y.K30 = 2 WHERE d.id = $1 RETURNING d.id;');
    });

    it('handles the same $N as BOTH a field-path key and a value', function() {
        var body = 'UPDATE bucket AS d SET d.flags.$2 = $2 WHERE d.id = $1 RETURNING d.id;';
        var out  = substitute(body, ['$1', '$2'], inlineParamsOf(body), ['doc-1', 'seen']);
        // the field-path .$2 is interpolated; the value `= $2` stays positional
        assert.equal(out, 'UPDATE bucket AS d SET d.flags.seen = $2 WHERE d.id = $1 RETURNING d.id;');
    });

    it("does not dollar-expand a field-key value containing $& (function replacer, not string)", function() {
        var body = 'UPDATE bucket AS d SET d.flags.$2 = 1 WHERE d.id = $1;';
        var out  = substitute(body, ['$1', '$2'], inlineParamsOf(body), ['doc-1', 'a$&b']);
        assert.equal(out, 'UPDATE bucket AS d SET d.flags.a$&b = 1 WHERE d.id = $1;');
    });

    it('leaves %N field-paths untouched (this loop only extracts $N)', function() {
        var body = 'UPDATE bucket AS d SET d.flags.%2 = 1 WHERE d.id = $1 RETURNING d.id;';
        // params/inlineParams are matched with /\$\w+/g, so %2 is never extracted -> never substituted
        var out  = substitute(body, ['$1'], inlineParamsOf(body), ['doc-1', 'seen']);
        assert.equal(out, body, '%N is not handled by this substitution loop (no regression, no new support)');
    });

});


// ─── 08 — #B153: N1QL onError guards the `cause` envelope (never hangs) ──────

describe('08 - #B153: onError guards err.cause so the query always settles', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR, 'utf8'); });

    it('both N1QL onError sites guard err.cause before reading first_error_message', function() {
        // The trailing `!== ''` clause is the #B153 RESIDUAL fix (see §08b): without
        // it this regex is an unanchored substring of the tightened guard and would
        // keep counting 3 while pinning nothing about the empty-message branch.
        var guardCount = (src.match(/err && err\.cause && typeof\(err\.cause\.first_error_message\) != 'undefined' && err\.cause\.first_error_message !== ''/g) || []).length;
        // #B429 — 2, not 3: register()'s two byte-identical dispatch blocks were collapsed
        // into one when the shared-emitter branch was removed. The remaining sites are
        // register()'s single onError and bulkInsert's.
        assert.equal(guardCount, 2, 'both onError sites carry the cause guard');
        // every `new Error(err.cause.first_error_message)` now sits inside a guarded branch
        var b153 = (src.match(/#B153/g) || []).length;
        assert.ok(b153 >= 3, 'each fixed site is annotated with the bug id');
    });

    it('the register() sites forward the raw error through onQueryCallback on the fallback path', function() {
        assert.match(src,
            /var error;\s*if \( err && err\.cause[\s\S]*?error = \(err instanceof Error\) \? err : new Error\(String\(err\)\);[\s\S]*?onQueryCallback\(error\);/,
            'guarded build-from-cause, else forward raw err, then always call onQueryCallback');
    });

    it('the bulkInsert site forwards the raw err on the fallback path', function() {
        // Pins the #B153 else-branch fallback only. The terminal self.emit is
        // deliberately NOT pinned here: #CE1 (slice 1) stamps the error inline as
        // it is emitted — `self.emit(trigger, lib.connectorError.stamp(error))` —
        // and that emit-stamp wiring is covered by connector-error.test.js §05.
        assert.match(src,
            /else \{\s*error = \(err instanceof Error\) \? err : new Error\(String\(err\)\);\s*\}/,
            'bulkInsert onError forwards the raw err on the socket-level fallback path');
    });

    /**
     * Pure-logic replica of the FIXED onError handler (register()/bulkInsert share
     * the same guard).
     *
     * @param {*} err
     * @param {function} terminal - onQueryCallback / self.emit stand-in
     * @returns {void}
     */
    function fixedOnError(err, terminal) {
        var error;
        if ( err && err.cause && typeof(err.cause.first_error_message) != 'undefined' && err.cause.first_error_message !== '' ) {
            error = new Error(err.cause.first_error_message);
            // #B509 — realigned with the shipped site: result rows redacted, cause shallow-copied.
            var _redactedBody = paramRedact.redactResultRows(err.cause.http_body);
            error.stack = 'trigger\n' + _redactedBody;
            error.cause = Object.assign({}, err.cause, { http_body: _redactedBody });
        } else {
            error = (err instanceof Error) ? err : new Error(String(err));
        }
        terminal(error);
    }

    /**
     * The pre-fix (unguarded) handler — the subtract control.
     *
     * @param {*} err
     * @param {function} terminal
     * @returns {void}
     */
    function oldOnError(err, terminal) {
        try {
            var error = new Error(err.cause.first_error_message); // throws when cause is absent
            error.stack = 'trigger\n' + err.cause.http_body;
            terminal(error);
        } catch (_err) {
            /* swallowed — terminal never fires → the request hangs forever */
        }
    }

    it('fixed handler: a socket-level error (no `cause`) still settles, forwarding the raw error', function() {
        var sockErr = new Error('connect ECONNREFUSED 127.0.0.1:8091');
        sockErr.code = 'ECONNREFUSED';
        var seen = null;
        fixedOnError(sockErr, function(e) { seen = e; });
        assert.ok(seen, 'terminal callback fired — no hang');
        assert.equal(seen.code, 'ECONNREFUSED', 'the raw error is forwarded, so code/errno survive for classification');
    });

    it('fixed handler: an N1QL error WITH a cause builds from first_error_message and keeps the raw cause', function() {
        var n1qlErr = { cause: { first_error_message: 'Timeout 1000ms exceeded', http_body: '{"errors":[{"code":1080}]}' } };
        var seen = null;
        fixedOnError(n1qlErr, function(e) { seen = e; });
        assert.equal(seen.message, 'Timeout 1000ms exceeded');
        assert.equal(seen.cause.first_error_message, 'Timeout 1000ms exceeded', 'raw cause preserved for downstream classification');
    });

    it('subtract control: the OLD handler HANGS on a socket-level error (terminal never called)', function() {
        var sockErr = new Error('connect ECONNREFUSED 127.0.0.1:8091');
        sockErr.code = 'ECONNREFUSED'; // no .cause envelope
        var settled = false;
        oldOnError(sockErr, function() { settled = true; });
        assert.equal(settled, false,
            'the pre-fix handler swallowed the TypeError and never settled — the hang #B153 fixes');
    });

    // ── #B153 RESIDUAL — an EMPTY envelope message must not destroy the typed
    //    SDK class name the classifier matches on. The node binding marshals
    //    first_error_code / first_error_message onto EVERY query error, so a
    //    CLIENT-side timeout reaches the handler with `cause` present but no
    //    server text: the 0.5.25 guard therefore synthesized `new Error('')`
    //    and a retryable timeout was reported permanent.

    /**
     * The handler as it shipped in 0.5.25 — guarded against a missing `cause`
     * (#B153) but NOT against an empty message. The residual subtract control.
     *
     * @param {*} err
     * @param {function} terminal
     * @returns {void}
     */
    function preResidualOnError(err, terminal) {
        var error;
        if ( err && err.cause && typeof(err.cause.first_error_message) != 'undefined' ) {
            error = new Error(err.cause.first_error_message);
            error.stack = 'trigger\n' + err.cause.http_body;
            error.cause = err.cause;
        } else {
            error = (err instanceof Error) ? err : new Error(String(err));
        }
        terminal(error);
    }

    /**
     * The measured client-side SDK timeout shape: a typed Error carrying a
     * `cause` envelope with a value-initialized (empty) message and code 0.
     *
     * @param {string} name - the SDK class name
     * @returns {Error}
     */
    function clientTimeout(name) {
        var e = new Error('unambiguous timeout (queried 1 node, 1 attempt)');
        e.name  = name;
        e.cause = { first_error_code: 0, first_error_message: '', http_body: '' };
        return e;
    }

    it('the new empty-message clause is present at both onError sites', function() {
        var clause = (src.match(/&& err\.cause\.first_error_message !== ''/g) || []).length;
        // #B429 — 2, not 3 (see the guard-count pin above: duplicate dispatch block removed).
        assert.equal(clause, 2, 'each site synthesizes only when there is envelope text to surface');
        // control: the clause is genuinely counted, not matched by accident
        assert.equal((src.match(/&& err\.cause\.first_error_message !== 'x'/g) || []).length, 0);
    });

    ['UnambiguousTimeoutError', 'AmbiguousTimeoutError'].forEach(function(name) {

        it('fixed handler: a client-side ' + name + ' is forwarded raw, keeping its typed name', function() {
            var timeoutErr = clientTimeout(name);
            var seen = null;
            fixedOnError(timeoutErr, function(e) { seen = e; });
            assert.equal(seen, timeoutErr, 'the raw SDK error itself is forwarded — not a synthesized copy');
            assert.equal(seen.name, name, 'the typed class name survives for the classifier');
            assert.notEqual(seen.message, '', 'the real timeout text survives instead of being blanked');
            assert.equal(seen.cause.first_error_code, 0, 'the envelope rides along on the raw error');
        });

        it('end-to-end: the forwarded ' + name + ' classifies TRANSIENT', function() {
            var seen = null;
            fixedOnError(clientTimeout(name), function(e) { seen = e; });
            var verdict = ce.classify(seen);
            assert.equal(verdict.isTransient, true, 'a client-side timeout is retryable');
            assert.equal(verdict.reason, 'couchbase:timeout');
        });

        it('subtract control: the 0.5.25 handler blanked ' + name + ' and classified it PERMANENT', function() {
            var seen = null;
            preResidualOnError(clientTimeout(name), function(e) { seen = e; });
            assert.equal(seen.message, '', 'the pre-residual guard synthesized new Error(\'\')');
            assert.equal(seen.name, 'Error', 'the typed class name was destroyed');
            assert.equal(ce.classify(seen).isTransient, false,
                'the false negative this residual fix closes — a retryable timeout reported permanent');
        });
    });

    it('raw-forwarding stays classification-lossless: an empty-message envelope still classifies off the code table', function() {
        // Pathological shape (no known producer): a SERVER envelope whose message
        // is empty. Raw-forwarding keeps `.cause`, so the N1QL code table — the
        // sole classifier for un-typed envelope errors — still fires.
        var envErr = new Error('index failure');
        envErr.cause = { first_error_code: 12008, first_error_message: '', http_body: '' };
        var seen = null;
        fixedOnError(envErr, function(e) { seen = e; });
        assert.equal(seen, envErr, 'forwarded raw');
        var verdict = ce.classify(seen);
        assert.equal(verdict.isTransient, true, 'the cause envelope survived the forward');
        assert.equal(verdict.reason, 'couchbase:bulk-get-retry-exhausted');
    });
});


// ─── 09 — `@options` .sql annotation: parse + the consistency gate ───────────
//
// Drives the SHIPPED bytes, not a replica: the `@options` parse block and the
// scan-consistency/passthrough gate are sliced out of the connector at run time
// and executed. Only `couchbase.QueryScanConsistency` is stubbed.
//
// Why text anchors and not line numbers or brace-matching: a line-range slice
// silently grabs the wrong region after any edit above it, and the parse block
// contains `/([{,]\s*)…/` — a regex whose character class holds an unbalanced
// `{` — so a naive brace-matcher runs past the block end. Both anchors are
// asserted unique, and §09.a fails loudly if a slice ever stops being the block.
//
// Motivation: the published guide documented `-- @options scanConsistency=request_plus`,
// which the parser cannot match AND whose key the gate does not read — two
// independent no-ops, SILENT until 0.5.26. The docs were corrected 2026-07-25
// and the connector now warns on both shapes (#B155: an unparseable `@options`
// mention, and a parsed one whose keys are dropped by the consistency gate);
// these tests pin the parse/gate contract AND the warns so the docs and the
// code cannot drift apart again unnoticed.

describe('09 - @options: parse + consistency gate (shipped bytes)', function() {

    var PARSE, GATE;

    /**
     * Slices an inclusive source region between two unique text anchors.
     *
     * @param {string} src
     * @param {string} startNeedle - must occur exactly once
     * @param {string} endNeedle   - must occur exactly once, after startNeedle
     * @returns {string}
     */
    function region(src, startNeedle, endNeedle) {
        var s = src.indexOf(startNeedle);
        assert.notEqual(s, -1, 'start anchor not found: ' + startNeedle);
        assert.equal(src.indexOf(startNeedle, s + 1), -1, 'start anchor not unique: ' + startNeedle);
        var e = src.indexOf(endNeedle, s);
        assert.notEqual(e, -1, 'end anchor not found: ' + endNeedle);
        assert.equal(src.indexOf(endNeedle, e + 1), -1, 'end anchor not unique: ' + endNeedle);
        return src.slice(s, e);
    }

    before(function() {
        var src = fs.readFileSync(CONNECTOR, 'utf8');
        PARSE = region(src, 'optionsArr = queryString.match(', 'optionsArr = null;');
        GATE  = region(src, 'queryOptions.scanConsistency = couchbase.QueryScanConsistency.NotBounded;',
                            '// _collection = queryStatement.match(');
    });

    /**
     * Runs the extracted blocks against one `.sql` body.
     *
     * @param {string} sql
     * @returns {{options: (object|null), queryOptions: object, warnings: Array.<string>}}
     */
    function run(sql) {
        // `queryStatement` is referenced by the gate's unknown-consistency warn.
        var fn = new Function('queryString', 'couchbase',
            'var queryStatement = queryString;\n' +
            'var optionsArr = null, options = null, userConsistencyOpt = null;\n' +
            'var queryOptions = { adhoc: false };\n' +          // the query path's real default
            'var warnings = [];\n' +
            'var console = { warn: function (m) { warnings.push(String(m)); } };\n' +
            PARSE + '\n' + GATE + '\n' +
            'return { options: options, queryOptions: queryOptions, warnings: warnings };');
        return fn(sql, { QueryScanConsistency: { NotBounded: 'not_bounded', RequestPlus: 'request_plus' } });
    }

    /** @param {string} body @returns {string} a `.sql` file body carrying `body` as its annotation */
    function sql(body) { return '/*\n * @options ' + body + '\n */\nSELECT * FROM `b` WHERE x = $1'; }

    // ── 09.a — extraction controls: a slice that grabbed the wrong region is not an instrument
    it('the extracted PARSE slice really is the @options parse block', function() {
        assert.match(PARSE, /queryString\.match\(\/\\@options \\\{\(\.\*\)\\\}\/gm\)/, 'carries the annotation regex');
        assert.match(PARSE, /options = JSON\.parse\(_jsonOpts\)/, 'carries the JSON.parse');
    });

    it('the extracted GATE slice really is the consistency gate', function() {
        assert.match(GATE, /if \(options && typeof\(options\.consistency\) != 'undefined'\)/, 'carries the gate');
        assert.match(GATE, /for \(let o in options\) \{/, 'carries the passthrough loop');
        assert.match(GATE, /queryOptions\[o\] = options\[o\];/, 'carries the assignment');
    });

    // ── 09.b — the forms the guide USED to document are inert, and silent about it
    it('the brace-less documented form does not parse — and now WARNS with the expected shape', function() {
        var r = run('-- @options scanConsistency=request_plus\nSELECT 1');
        assert.equal(r.options, null, 'the annotation never matched the parser');
        assert.equal(r.queryOptions.scanConsistency, 'not_bounded', 'left at the default');
        assert.equal(r.warnings.length, 1, '#B155: the historical silent no-op now warns');
        assert.match(r.warnings[0], /could not parse a brace-delimited object/);
        assert.match(r.warnings[0], /@options \{ consistency/, 'the warn shows the exact working form');
    });

    it('the braced-but-wrong-key form PARSES, does nothing — and now WARNS naming the dropped key', function() {
        var r = run(sql('{ scanConsistency: "request_plus" }'));
        assert.notEqual(r.options, null, 'it does parse — which is what makes it deceptive');
        assert.equal(r.queryOptions.scanConsistency, 'not_bounded', 'the gate reads `consistency`, not `scanConsistency`');
        assert.equal(typeof r.queryOptions.scanConsistency_, 'undefined');
        assert.equal(r.warnings.length, 1, '#B155: the gate-shut drop now warns');
        assert.match(r.warnings[0], /missing a `consistency` key/);
        assert.match(r.warnings[0], /ignoring: scanConsistency/, 'the dropped key is named');
    });

    // ── 09.c — the corrected, documented form works
    it('the corrected form applies request_plus', function() {
        var r = run(sql('{ consistency: "request_plus" }'));
        assert.equal(r.queryOptions.scanConsistency, 'request_plus');
        assert.equal(r.warnings.length, 0);
    });

    // ── 09.d — the documented gate rule
    it('a non-consistency key ALONE is dropped (the #B155 gate) — and now WARNS', function() {
        var r = run(sql('{ adhoc: true }'));
        assert.notEqual(r.options, null, 'it parsed');
        assert.equal(r.options.adhoc, true, 'and the value was read');
        assert.equal(r.queryOptions.adhoc, false, 'but never reached queryOptions — the gate stayed shut');
        assert.equal(r.warnings.length, 1, '#B155: the drop is no longer silent');
        assert.match(r.warnings[0], /ignoring: adhoc/);
        assert.match(r.warnings[0], /"consistency": "not_bounded"/, 'the warn hands over the fix');
    });

    it('a DOUBLE space before the brace also misses the parser — and warns (the gap the warn regex closed)', function() {
        // The parse regex demands exactly `@options {`; `@options  {` never matches.
        var r = run('/*\n * @options  { consistency: "request_plus" }\n */\nSELECT 1');
        assert.equal(r.options, null, 'two spaces defeat the annotation regex');
        assert.equal(r.queryOptions.scanConsistency, 'not_bounded');
        assert.equal(r.warnings.length, 1, 'caught by the unparseable-@options warn');
        assert.match(r.warnings[0], /could not parse a brace-delimited object/);
    });

    it('an EMPTY `@options {}` parses, drops nothing, and deliberately stays quiet', function() {
        var r = run(sql('{}'));
        assert.notEqual(r.options, null, 'empty object parses');
        assert.equal(Object.keys(r.options).length, 0);
        assert.equal(r.warnings.length, 0, 'no keys were dropped, so there is nothing to warn about');
    });

    it('the same key alongside `consistency` IS applied', function() {
        var r = run(sql('{ consistency: "not_bounded", adhoc: true }'));
        assert.equal(r.queryOptions.adhoc, true, 'the gate opened, so the passthrough ran');
        assert.equal(r.queryOptions.scanConsistency, 'not_bounded');
    });

    it('an arbitrary key (timeout) passes through once the gate is open', function() {
        var r = run(sql('{ consistency: "not_bounded", timeout: 1 }'));
        assert.equal(r.queryOptions.timeout, 1);
    });

    it('an UNKNOWN consistency warns, keeps the default, but still opens the gate', function() {
        var r = run(sql('{ consistency: "bogus_level", timeout: 5 }'));
        assert.equal(r.queryOptions.scanConsistency, 'not_bounded', 'unrecognised value falls back');
        assert.equal(r.warnings.length, 1, 'and DOES warn — unlike the silent failures above');
        assert.match(r.warnings[0], /QueryScanConsistency/);
        assert.equal(r.queryOptions.timeout, 5, 'the gate keys on PRESENCE, not validity');
    });

    // ── 09.e — the documented defaults
    it('no @options at all leaves the documented defaults', function() {
        var r = run('SELECT * FROM `b`');
        assert.equal(r.options, null);
        assert.equal(r.queryOptions.adhoc, false, 'query path defaults adhoc to FALSE (plans cached)');
        assert.equal(r.queryOptions.scanConsistency, 'not_bounded');
    });

    it('a malformed @options body warns instead of corrupting options', function() {
        var r = run(sql('{ consistency: }'));
        assert.equal(r.options, null, 'parse failed, options left null');
        assert.equal(r.warnings.length, 1, 'the CB-QUAL-2 explicit-parse-error path');
        assert.match(r.warnings[0], /@options parse error/);
    });
});


// ─── 10 — #B243: unserializable query parameters are refused, never dispatched ─
//
// The defect this locks is a PROCESS ABORT, not a throwable error. The SDK maps
// `JSON.stringify` over the parameter list; for a function, a symbol or an
// `undefined` that returns the VALUE `undefined` rather than a string, the
// native binding coerces it to `""`, and the C++ core's JSON parse of `""`
// throws `tao::pegtl::parse_error` on an internal thread -> `std::terminate()`
// -> `abort()` (measured against a live cluster on SDK 4.1.3 AND 4.7.1: exit
// 134, with no `uncaughtException` / `unhandledRejection` / `exit` hook firing).
// So the bundle dies instead of the request 500-ing, and nothing in JS can
// intercept it — which is exactly why the guard has to run BEFORE dispatch.
//
// Drives the SHIPPED bytes of `getUnserializableParamError`, not a replica.
// Text-anchored (not brace-matched): jsdoc.md's brace-walk caveat — a `{` inside
// a string literal or a commented-out region derails the walk — and both anchors
// are asserted unique so a slice that stopped being the function fails loudly.

describe('10 - #B243: unserializable query parameters (shipped bytes)', function() {

    var GUARD, src;

    /**
     * Slices an inclusive source region between two unique text anchors.
     *
     * @param {string} s - source
     * @param {string} startNeedle - must occur exactly once
     * @param {string} endNeedle - must occur exactly once, after startNeedle
     * @returns {string}
     */
    function region(s, startNeedle, endNeedle) {
        var a = s.indexOf(startNeedle);
        assert.notEqual(a, -1, 'start anchor not found: ' + startNeedle);
        assert.equal(s.indexOf(startNeedle, a + 1), -1, 'start anchor not unique: ' + startNeedle);
        var b = s.indexOf(endNeedle, a);
        assert.notEqual(b, -1, 'end anchor not found: ' + endNeedle);
        assert.equal(s.indexOf(endNeedle, b + 1), -1, 'end anchor not unique: ' + endNeedle);
        return s.slice(a, b);
    }

    before(function() {
        src   = fs.readFileSync(CONNECTOR, 'utf8');
        GUARD = region(src, 'var getUnserializableParamError = function(',
                            '* Runs EXPLAIN on a N1QL statement');
        // The end anchor sits inside the NEXT JSDoc block, so the raw slice trails an
        // unterminated `/**`. Cut back to the function's own terminator.
        GUARD = GUARD.slice(0, GUARD.lastIndexOf('};') + 2);
    });

    /**
     * Executes the extracted guard against one assembled parameter list.
     *
     * @param {Array|object} queryParams
     * @param {Array} [params] - declared placeholders
     * @returns {TypeError|null}
     */
    function run(queryParams, params) {
        var fn = new Function('queryParams', 'params',
            GUARD.replace(/^var getUnserializableParamError = /, 'var _guard = ') + '\n' +
            'return _guard(queryParams, "invoice", "getByRef", "/models/n1ql/invoice/getByRef.sql", params);');
        return fn(queryParams, params || ['$1', '$2']);
    }

    // ── 10.a — extraction control: a slice that grabbed the wrong region is not an instrument
    it('the extracted slice really is the guard function', function() {
        assert.match(GUARD, /typeof/, 'carries a typeof test');
        assert.match(GUARD, /symbol/, 'carries the symbol arm');
        assert.ok(GUARD.split('{').length === GUARD.split('}').length,
            'braces balance — the slice is a complete function, not a truncated one');
    });

    // ── 10.b — the hazard premise: exactly which values JSON.stringify renders as `undefined`
    it('PREMISE: JSON.stringify returns undefined for undefined, functions and symbols only', function() {
        assert.equal(JSON.stringify(undefined), undefined);
        assert.equal(JSON.stringify(function () {}), undefined);
        assert.equal(JSON.stringify(Symbol('s')), undefined);
        // the near neighbours that must stay ALLOWED
        assert.equal(JSON.stringify(null), 'null');
        assert.equal(JSON.stringify({ a: undefined, b: 1 }), '{"b":1}');
        assert.equal(JSON.stringify(0), '0');
        assert.equal(JSON.stringify(''), '""');
    });

    // ── 10.c — the guard REFUSES every fatal shape
    it('refuses a bare undefined parameter', function() {
        var err = run(['a', undefined]);
        assert.ok(err instanceof TypeError, 'returns a TypeError');
        assert.equal(err.code, 'GINA_COUCHBASE_UNSERIALIZABLE_PARAM');
        assert.match(err.message, /\$2/, 'names the offending 1-based position');
        assert.match(err.message, /undefined/);
    });

    it('refuses a function parameter and explains the callback-arity cause', function() {
        var err = run(['a', function cb() {}]);
        assert.ok(err instanceof TypeError);
        assert.equal(err.code, 'GINA_COUCHBASE_UNSERIALIZABLE_PARAM');
        assert.match(err.message, /function/);
        assert.match(err.message, /callback/i, 'points at the real cause: a callback in a parameter slot');
    });

    it('refuses a symbol parameter', function() {
        var err = run(['a', Symbol('s')]);
        assert.ok(err instanceof TypeError);
        assert.equal(err.code, 'GINA_COUCHBASE_UNSERIALIZABLE_PARAM');
    });

    it('refuses an unserializable value in the NAMED-parameter map form', function() {
        var err = run({ ref: 'a', since: undefined });
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /since/, 'names the offending key');
    });

    // ── 10.d — and does NOT over-reject: these must still reach the SDK
    it('allows a fully serializable positional list', function() {
        assert.equal(run(['a', 'b']), null);
    });

    it('allows null — the SDK serializes it fine and it is the documented empty value', function() {
        assert.equal(run([null, null]), null);
    });

    it('allows falsy-but-serializable values (0, empty string, false)', function() {
        assert.equal(run([0, '']), null);
        assert.equal(run([false, 'x']), null);
    });

    it('allows an object carrying an undefined PROPERTY (it stringifies away)', function() {
        assert.equal(run([{ a: undefined, b: 1 }, 'x']), null);
    });

    it('allows an empty parameter list', function() {
        assert.equal(run([]), null);
    });

    // ── 10.e — the guard is actually WIRED before dispatch, and routes to the callback
    it('is called at the parameters assignment site, before the query is dispatched', function() {
        var callIdx   = src.indexOf('getUnserializableParamError(queryParams');
        var assignIdx = src.indexOf('queryOptions.parameters = queryParams;');
        var execIdx   = src.indexOf('execQuery = inherits(conn, conn._cluster.query)');
        assert.notEqual(callIdx, -1, 'the guard is invoked on the query path');
        assert.notEqual(assignIdx, -1);
        assert.ok(callIdx > execIdx, 'guard runs on the assembled list');
        assert.ok(callIdx < src.indexOf('conn._cluster.query(query, queryOptions)'),
            'guard runs BEFORE the SDK dispatch — after it would be too late, the abort is uncatchable');
    });

    it('surfaces through the callback when there is one, else throws', function() {
        var blk = region(src, 'var _unserializableErr = getUnserializableParamError(queryParams',
                              'queryOptions.parameters = queryParams;');
        assert.match(blk, /_mainCallback\s*\)\s*\{[\s\S]{0,120}?return _mainCallback\(_unserializableErr\)/,
            'callback form — matches the missing-context precedent at the top of the method');
        assert.match(blk, /throw _unserializableErr/, 'throw form when the caller passed no callback');
    });
});


// ─── 11 — #B412: the `{number}` branch derives the count without a regex ─────
//
// The former branch parsed the COUNT alias out of the query text with
// `COUNT\(\S+\)\s+AS\s+(\w+)` and dereferenced the match UNGUARDED. `\S+` cannot
// span whitespace, so `COUNT(DISTINCT a.b) AS n` matched neither alternative, and
// an unaliased `COUNT(*)` matched nothing either — `null[1]` then threw INSIDE the
// connector's own result callback, so a promisified caller never settled and the
// request hung with no response and no 5xx.
//
// mysql / postgresql / scylladb / sqlite all derive the count with no regex at
// all; this branch now mirrors them. Pins below are validated red-first against
// the pre-change source (see the §11c replica for the behavioural half).

describe('11 - #B412: {number} branch converged on the sibling pattern', function() {

    var src, blk, blkNoComments;
    before(function() {
        src = fs.readFileSync(CONNECTOR, 'utf8');
        // Text anchors, not line numbers (see the note above §09): isolate the
        // `{number}` branch from its `else if` to the start of the next statement.
        var start = src.indexOf("} else if ( returnType && returnType == 'number'");
        assert.ok(start > -1, 'the {number} branch must still exist');
        var rest  = src.slice(start);
        var end   = rest.indexOf('\n                        try {');
        assert.ok(end > -1, 'the branch must be followed by the callback dispatch');
        blk = rest.slice(0, end);
        // The fix DOCUMENTS the defect it replaced, so the old pattern legitimately
        // appears in this block's comments. Strip them before asserting absence.
        blkNoComments = blk.replace(/\/\/[^\n]*/g, '');
    });

    it('§11a — the comment strip is real (control: it must not empty the block)', function() {
        // Without this, a broken strip would make every absence pin below pass vacuously.
        assert.match(blkNoComments, /countKeys/,
            'stripped block must still contain live code');
        assert.ok(blkNoComments.length < blk.length,
            'the strip must actually remove something (the block is commented)');
    });

    it('§11b — no alias regex survives in the executable code', function() {
        // Literal match, not a nested regex: the source escapes the paren
        // (`COUNT\(\S+\)`), and a needle that misses that escape passes on the
        // PRE-change source too — i.e. a pin that cannot fail. Caught by the
        // red-first harness; see #B412.
        assert.equal(blkNoComments.indexOf('COUNT\\(\\S+\\)'), -1,
            'the COUNT alias regex must be gone from live code');
        assert.doesNotMatch(blkNoComments, /re\.lastIndex/,
            'the `re.lastIndex` capture-index idiom must be gone');
        assert.doesNotMatch(blkNoComments, /returnVariable/,
            'the dead returnVariable indirection must be gone');
    });

    it('§11c — the guarded first-column extraction is present', function() {
        assert.match(blkNoComments, /Array\.isArray\(data\)/,       'guards that data is an array');
        assert.match(blkNoComments, /data\.length\s*>\s*0/,          'guards a non-empty result set');
        assert.match(blkNoComments, /data\[0\]\s*!==\s*null/,        'guards typeof null === object');
        assert.match(blkNoComments, /Object\.keys\(data\[0\]\)/,     'reads the projected columns');
        assert.match(blkNoComments, /countKeys\[0\]\]/,              'indexes keys[0], NOT the key array');
    });

    it('§11d — keys are indexed, never coerced (the silent-undefined trap)', function() {
        // `row[Object.keys(row)]` stringifies the key ARRAY: a two-key row becomes
        // "a,b" -> undefined. Only `keys[0]` is correct.
        assert.doesNotMatch(blkNoComments, /data\[0\]\[Object\.keys\(data\[0\]\)\]/,
            'must not use the array-coercion idiom');
    });

    it('§11e — COUNT detection accepts both spacings in one expression', function() {
        assert.match(blkNoComments, /\/count\\s\*\\\(\/i/,
            'uses /count\\s*\\(/i like the sibling connectors');
    });

    // ── behavioural half: a pure-logic replica of the shipped branch ──
    /**
     * Replica of the shipped `{number}` extraction. Kept line-for-line with the
     * connector so a divergence shows up as a failing pin above, not silently here.
     */
    function extractCount(data) {
        if (Array.isArray(data) && data.length > 0 && typeof(data[0]) == 'object' && data[0] !== null) {
            var countKeys = Object.keys(data[0]);
            return (countKeys.length > 0) ? data[0][countKeys[0]] : 0;
        }
        return 0;
    }

    it('§11f — every shape that used to throw now returns a number', function() {
        assert.equal(extractCount([{ n: 42 }]), 42,        'aliased COUNT');
        assert.equal(extractCount([{ '$1': 7 }]), 7,        'unaliased COUNT(*) — driver-assigned key');
        assert.equal(extractCount([{ n: 3, m: 9 }]), 3,     'multi-column: first projected column');
        assert.equal(extractCount([{}]), 0,                 'row with no columns');
        assert.equal(extractCount([]), 0,                   'EMPTY result set (the second unguarded deref)');
        assert.equal(extractCount(null), 0,                 'null payload');
        assert.equal(extractCount([null]), 0,               'null row — typeof null === object');
    });

    it('§11g — none of those shapes can throw (the hang was a throw in a callback)', function() {
        [[{ n: 1 }], [], [{}], null, [null], undefined, 'x', [{ a: 1, b: 2 }]].forEach(function(shape) {
            assert.doesNotThrow(function() { extractCount(shape); },
                'shape ' + JSON.stringify(shape) + ' must not throw');
        });
    });
});


// ─── 12 — #B412: the @return annotation parser no longer over-captures ───────

describe('12 - #B412: @return capture is bounded to the first brace pair', function() {

    it('§12a — the source uses [^}]+, matching the sibling connectors', function() {
        var src = fs.readFileSync(CONNECTOR, 'utf8');
        var line = src.split('\n').filter(function(l) {
            return /returnType\s*=\s*queryString\.match\(/.test(l);
        })[0];
        assert.ok(line, 'the returnType extraction line must exist');
        assert.match(line, /\[\^\}\]\+/,  'must use the bounded [^}]+ class');
        assert.doesNotMatch(line, /\{\(\.\*\)\}/, 'must not use the greedy (.*) form');
    });

    it('§12b — behavioural: a second brace pair on the line no longer bleeds in', function() {
        var shipped = /@return\s+\{([^}]+)\}/;
        assert.equal('@return {number} n'.match(shipped)[1], 'number');
        assert.equal('@return {object} note {x}'.match(shipped)[1], 'object',
            'the trailing {x} must not be absorbed');
        // control: the greedy form genuinely fails this case, so the pin above is not vacuous
        assert.equal('@return {object} note {x}'.match(/@return\s+\{(.*)\}/)[1], 'object} note {x');
    });
});


// ─── 13 — #B413: annotation types are normalised and brace-bounded ───────────
//
// Both extracted annotation types feed EXACT-MATCH comparisons whose arms are all
// lowercase: `returnType` against the `== 'number'` / `'object'` / `'boolean'`
// branch chain, and `paramTypes[t]` against cast()'s switch. So a capitalised or
// space-padded type — `{Number}`, `{ number }` — matched nothing and the value was
// SILENTLY left undispatched/uncast rather than erroring. The four sibling
// connectors all normalise with `.trim().toLowerCase()`; couchbase now does too.
// Greedy `(.*)` is bounded to `[^}]+` on both, so a second brace pair on the same
// line no longer bleeds into the captured type.

describe('13 - #B413: annotation type normalisation + bounded capture', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR, 'utf8'); });

    it('§13a — returnType is trimmed and lowercased at extraction', function() {
        var i = src.indexOf('returnType = queryString.match(');
        assert.ok(i > -1, 'the returnType extraction must exist');
        // 1400, not 700: the fix's own comment block sits between the anchor and the
        // normalisation (measured gap 743 chars), so a tight window false-fails.
        var window = src.slice(i, i + 1400);
        assert.match(window, /returnType\[1\]\.trim\(\)\.toLowerCase\(\)/,
            'must normalise like the sibling connectors');
    });

    it('§13b — paramTypes are trimmed, lowercased and brace-bounded', function() {
        var i = src.indexOf('paramTypes = queryString.match(');
        assert.ok(i > -1, 'the paramTypes extraction must exist');
        var window = src.slice(i, i + 600);
        // Anchor on the @param expression ITSELF, not the byte window: the window
        // reaches into the adjacent @return line, which already carries [^}]+ from
        // #B412, so a window-scoped token check passes on pre-change bytes too.
        assert.ok(src.indexOf('/\\@param \\{([^}]+)\\}/gm') > -1, 'outer capture bounded');
        assert.match(window, /\.trim\(\)\.toLowerCase\(\)/,      'normalised before the cast switch');
        assert.doesNotMatch(window, /match\(\/\\\{\(\.\*\)\\\}\//, 'inner greedy form must be gone');
    });

    it('§13c — TYPE annotations are bounded; @options stays greedy ON PURPOSE', function() {
        // The distinction is what the annotation holds, not a blanket style rule:
        //   @return / @param -> a single type TOKEN, which can never contain `}`
        //                       => bounded [^}]+, so a later brace pair cannot bleed in.
        //   @options         -> a JavaScript OBJECT LITERAL, JSON.parse'd after the keys
        //                       are quoted, which CAN nest braces
        //                       => greedy (.*), because [^}]+ truncates `{ a: { b: 1 } }`
        //                          to `{ a: { b: 1 }` and breaks the parse.
        // Verified by measurement, not assumed — see #B413.
        assert.doesNotMatch(src, /@return[^\n]*\\\{\(\.\*\)\\\}/,  '@return must not be greedy');
        assert.doesNotMatch(src, /@param[^\n]*\\\{\(\.\*\)\\\}/,   '@param must not be greedy');
        assert.match(src, /\\@options \\\{\(\.\*\)\\\}/,
            '@options MUST stay greedy — it holds a nestable object literal');
    });

    it('§13c-bis — behavioural: bounding @options would corrupt a nested object', function() {
        // The control for the pin above: prove the greedy form is load-bearing.
        var greedy  = /\@options \{(.*)\}/;
        var bounded = /\@options \{([^}]+)\}/;
        var nested  = '@options { a: { b: 1 } }';
        assert.equal(nested.match(greedy)[0],  '@options { a: { b: 1 } }', 'greedy keeps the whole object');
        assert.equal(nested.match(bounded)[0], '@options { a: { b: 1 }',   'bounded TRUNCATES it');
    });

    // ── behavioural replicas ──

    /** Replica of the shipped returnType extraction. */
    function extractReturnType(q) {
        var m = q.match(/@return\s+\{([^}]+)\}/);
        return Array.isArray(m) ? m[1].trim().toLowerCase() : null;
    }
    /** Replica of the shipped paramTypes extraction. */
    function extractParamTypes(q) {
        var pts = q.match(/\@param \{([^}]+)\}/gm);
        if (!pts || !Array.isArray(pts)) return [];
        return pts.map(function(p) { return p.match(/\{([^}]+)\}/)[1].trim().toLowerCase(); });
    }

    it('§13d — capitalised and padded return types now reach their branch', function() {
        assert.equal(extractReturnType('@return {number}'),   'number', 'canonical (control)');
        assert.equal(extractReturnType('@return {Number}'),   'number', 'capitalised');
        assert.equal(extractReturnType('@return { number }'), 'number', 'space-padded');
        assert.equal(extractReturnType('@return {NUMBER}'),   'number', 'upper');
        assert.equal(extractReturnType('@return {object} note {x}'), 'object',
            'a second brace pair must not bleed in');
        assert.equal(extractReturnType('SELECT 1'), null, 'no annotation (control: still null)');
    });

    it('§13e — param types normalise for cast()\'s lowercase switch', function() {
        assert.deepEqual(extractParamTypes('/** @param {string} a */'), ['string'], 'canonical (control)');
        assert.deepEqual(extractParamTypes('/** @param {Number} a */'), ['number'], 'capitalised now casts');
        assert.deepEqual(extractParamTypes('/** @param { Float } a */'), ['float'],  'padded + capitalised');
        assert.deepEqual(extractParamTypes('/** @param {a} and {b} */'), ['a'],
            'greedy over-capture is gone — was "a} and {b"');
        assert.deepEqual(extractParamTypes('SELECT 1'), [], 'no annotation (control: empty)');
    });

    it('§13f — the cast switch arms are all lowercase (why normalisation matters)', function() {
        var i = src.indexOf('var cast = function(dataArray, paramTypes)');
        assert.ok(i > -1, 'cast() must exist');
        var body = src.slice(i, i + 700);
        (body.match(/case '([^']+)'/g) || []).forEach(function(c) {
            var lit = c.replace(/case '|'/g, '');
            assert.equal(lit, lit.toLowerCase(), 'switch arm ' + c + ' is lowercase');
        });
    });
});

// ─── 14 — #B460: bulkInsert's outer catch settles instead of returning undefined ─
/**
 * `bulkInsert`'s outer `try` wraps its OWN function body, so a synchronous throw
 * in the prologue landed in a catch that only `console.error`d — the function
 * then fell off the end and returned `undefined`. Both documented call shapes
 * broke: `.onComplete(cb)` threw `TypeError: … reading 'onComplete'`, and the
 * `await` form (the docblock's first @example) resolved with `undefined`, so a
 * caller treating "did not throw" as success recorded an insert that never
 * happened.
 *
 * The trigger is NOT only a cluster outage: the prologue carries two DELIBERATE
 * argument validations (`rec` falsy; a record without `.values`) whose errors the
 * author wrote to reach the caller. Those make the defect drivable with no
 * cluster at all, which is what these tests exercise.
 *
 * Distinct from the query path, which does NOT share this shape: its promise is
 * built inside `entities[entityName].prototype[name] = function(){…}`, an
 * ATTACHED method, so its enclosing try has already exited by call time and a
 * throw propagates to the caller normally. §14f pins that difference.
 */
describe('14 - #B460: bulkInsert settles its outer catch (shipped bytes)', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR, 'utf8'); });

    var BI_START = 'var bulkInsert = function(rec, options) {';
    var BI_END   = '    /**\n     * getCluster';

    /** Extract bulkInsert's real body, anchored on unique text (never line numbers). */
    function bulkInsertBody() {
        var a = src.indexOf(BI_START);
        assert.ok(a > -1, 'bulkInsert definition must be found');
        assert.equal(src.indexOf(BI_START, a + 1), -1, 'the anchor must be unique');
        var b = src.indexOf(BI_END, a);
        assert.ok(b > a, 'the getCluster terminator must follow bulkInsert');
        var body = src.slice(a + BI_START.length, b);
        return body.slice(0, body.lastIndexOf('}'));
    }

    /** Build a callable from the extracted bytes, stubbing every free identifier. */
    function build(body, opts) {
        opts = opts || {};
        var queried = { n: 0 };
        var stubs = {
            merge          : function(o, q) { return Object.assign({}, o, q); },
            envIsDev       : !!opts.dev,
            paramRedact    : { captureValues: function() { return true; } },
            infos          : { bundle: 'test' },
            resolveCluster : function() {
                return { query: function() { queried.n++; return { then: function() {} }; } };
            },
            console        : { debug: function() {}, error: function() {}, warn: function() {} }
        };
        var keys = Object.keys(stubs);
        var fn = new Function(keys.concat(['rec', 'options']).join(','), body);
        var ent = {
            getConnection : function() { return {}; },
            _scope : 'sc', _collection : 'co', database : 'db', name : 'Ent'
        };
        return {
            call    : function(rec, options) {
                return fn.apply(ent, keys.map(function(k) { return stubs[k]; }).concat([rec, options]));
            },
            queried : queried
        };
    }

    it('§14a — the extraction really grabbed bulkInsert (anti-vacuity)', function() {
        var body = bulkInsertBody();
        assert.ok(body.length > 5000, 'body should be substantial, got ' + body.length);
        assert.ok(body.indexOf('var _settle = function') > -1, 'must contain _settle');
        assert.ok(body.indexOf('_promise.onComplete = function') > -1, 'must contain the shim');
        assert.ok(body.indexOf('`rec` argument cannot be left') > -1, 'must contain the rec validation');
        assert.ok(body.indexOf('RETURNING ') > -1, 'must contain the INSERT statement build');
    });

    it('§14b — the outer catch settles the promise and returns it', function() {
        var body = bulkInsertBody();
        // Comments are stripped so the fix's own explanatory text (which names the
        // defect) cannot satisfy a pin about the CODE.
        var code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(/\}\s*catch\s*\(\s*err\s*\)\s*\{[\s\S]{0,400}?_settle\s*\(\s*err\s*\)/.test(code),
            'the outer catch must call _settle(err)');
        assert.ok(/\}\s*catch\s*\(\s*err\s*\)\s*\{[\s\S]{0,400}?return\s+_promise/.test(code),
            'the outer catch must return _promise');
        // anti-vacuity: the strip must not have emptied the corpus
        assert.ok(code.indexOf('_settle') > -1, 'control: _settle survives the comment strip');
    });

    it('§14c — the promise plumbing is built BEFORE the try (so the catch can use it)', function() {
        var body = bulkInsertBody();
        var tryAt   = body.indexOf('        try {');
        var promAt  = body.indexOf('var _promise = new Promise');
        var settleAt= body.indexOf('var _settle = function');
        var shimAt  = body.indexOf('_promise.onComplete = function');
        assert.ok(tryAt > -1 && promAt > -1 && settleAt > -1 && shimAt > -1, 'all four anchors must exist');
        assert.ok(promAt   < tryAt, '_promise must be constructed before the try');
        assert.ok(settleAt < tryAt, '_settle must be defined before the try');
        assert.ok(shimAt   < tryAt, 'the .onComplete shim must be attached before the try');
    });

    it('§14d — POSITIVE CONTROL: a valid rec still returns a thenable and reaches the driver', function() {
        var h = build(bulkInsertBody());
        var out = h.call({ 'doc-1': { values: { a: 1 } } });
        assert.ok(out && typeof out.then === 'function', 'valid rec must return a thenable');
        assert.equal(typeof out.onComplete, 'function', 'and must carry the .onComplete shim');
        assert.equal(h.queried.n, 1, 'and must reach resolveCluster(conn).query() exactly once');
    });

    it('§14e — a prologue throw is delivered to BOTH documented call shapes', async function() {
        var cases = [
            [ 'rec undefined',        undefined,      '`rec` argument cannot be left' ],
            [ 'record без .values',   { d: {} },      '.values not found' ]
        ];
        for (var i = 0; i < cases.length; i++) {
            var label = cases[i][0], rec = cases[i][1], needle = cases[i][2];
            var h = build(bulkInsertBody());
            var out = h.call(rec);

            assert.notEqual(out, undefined, label + ': must not return undefined');
            assert.equal(typeof out.onComplete, 'function', label + ': must carry .onComplete');
            assert.equal(h.queried.n, 0, label + ': must not reach the driver');

            // shape 1 — .onComplete(cb) receives the error
            var got = await new Promise(function(resolve) {
                out.onComplete(function(err) { resolve(err); });
                setTimeout(function() { resolve(new Error('NOT DELIVERED')); }, 50);
            });
            assert.ok(got instanceof Error, label + ': .onComplete must receive an Error');
            assert.ok(got.message.indexOf(needle) > -1,
                label + ': .onComplete must receive the REAL validation error, got: ' + got.message);

            // shape 2 — await rejects
            var rejected = false;
            try { await out; } catch (e) { rejected = true; }
            assert.ok(rejected, label + ': the await form must reject, not resolve with undefined');
        }
    });

    it('§14f — the QUERY path does not share the shape (its promise is in an attached method)', function() {
        var attachAt = src.indexOf('entities[entityName].prototype[name] = function() {');
        var qPromAt  = src.indexOf('var _promise = new Promise', attachAt);
        assert.ok(attachAt > -1, 'the prototype attachment site must exist');
        assert.ok(qPromAt > attachAt,
            'the query-path promise must sit INSIDE the attached method — its enclosing try has ' +
            'already exited by call time, so a throw reaches the caller and #B460 does not apply there');
    });
});

// ─── 15 — #B461: a failed entity registration names itself ───────────────────
/**
 * `readSource()` guards ~770 lines of entity-class construction and `.sql`-derived
 * method attachment (`inherits(...)`, the prototype stamping, the per-method
 * attachment) under ONE try, whose catch was a bare `console.error(err.stack)`.
 * None of readSource()'s three call sites captures a result or takes an error
 * argument, so a throw there left the entity partially built — or absent — with
 * nothing in the log naming WHICH entity or WHICH .sql file caused it. The first
 * symptom is a missing method at request time, arbitrarily far from the cause.
 *
 * Scope note: this pins the DIAGNOSTIC only. Boot still continues past a failed
 * registration — whether an unbuildable entity should be fatal is a separate,
 * consumer-visible decision and is deliberately NOT made here.
 *
 * Distinct from #B460, which was a per-call return-contract defect in bulkInsert.
 */
describe('15 - #B461: entity registration failures are named (shipped bytes)', function() {

    var src;
    before(function() { src = fs.readFileSync(CONNECTOR, 'utf8'); });

    /** Isolate readSource()'s OUTER catch body — the one closing the ~770-line try. */
    function outerCatchBody() {
        var rs = src.indexOf('var readSource = function (entities, entityName, source, altMethodName) {');
        assert.ok(rs > -1, 'readSource must be found');
        var marker = '\n            } catch (err) {\n';
        var c = src.indexOf(marker, rs);
        assert.ok(c > rs, 'readSource outer catch must be found');
        var end = src.indexOf('\n            }\n', c + marker.length);
        assert.ok(end > c, 'the catch must terminate');
        return src.slice(c + marker.length, end);
    }

    it('§15a — the extraction really grabbed readSource\'s outer catch (anti-vacuity)', function() {
        var body = outerCatchBody();
        assert.ok(body.indexOf('console.error') > -1, 'the catch must log');
        assert.ok(body.length < 2000, 'and must be a catch body, not half the file (' + body.length + ')');
    });

    it('§15b — the catch names the entity and the source file', function() {
        // Comments stripped so the fix's own explanatory text cannot satisfy a pin
        // about the CODE.
        var code = outerCatchBody()
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(code.indexOf('entityName') > -1, 'must name the entity in the diagnostic');
        assert.ok(code.indexOf('source')     > -1, 'must name the .sql source in the diagnostic');
        assert.ok(code.indexOf('console.error') > -1,
            'control: console.error survives the comment strip');
    });

    it('§15c — the original err.stack line is PRESERVED (observability not reduced)', function() {
        var code = outerCatchBody()
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(/console\.error\(\s*err\.stack\s*\)/.test(code),
            'the pre-existing err.stack log must still be emitted, not replaced');
    });

    it('§15d — executed: the emitted diagnostic carries entity, file and cause', function() {
        var lines = [];
        var fn = new Function('console', 'entityName', 'source', 'name', 'err', outerCatchBody());
        fn({ error: function(m) { lines.push(String(m)); } },
           'invoice', '/p/b/models/entities/invoice/findAll.sql', 'findAll',
           Object.assign(new Error('boom from inherits'), { stack: 'STACK-MARKER' }));

        var joined = lines.join('\n');
        assert.ok(joined.indexOf('invoice')   > -1, 'must name the entity, got: ' + joined);
        assert.ok(joined.indexOf('findAll.sql') > -1, 'must name the .sql source, got: ' + joined);
        assert.ok(joined.indexOf('boom from inherits') > -1, 'must carry the cause message');
        assert.ok(joined.indexOf('STACK-MARKER') > -1, 'must still emit the original stack');
    });

    it('§15e — CONTROL: a different catch in this file does NOT satisfy the pin', function() {
        // The @options parse catch is a deliberately-scoped warn. If §15b's needles
        // matched it too, they would be asserting nothing specific to readSource.
        var i = src.indexOf('} catch (parseErr) {');
        assert.ok(i > -1, 'the @options catch must exist (control anchor)');
        var other = src.slice(i, i + 300);
        assert.equal(other.indexOf('entityName'), -1,
            'control: the @options catch must NOT mention entityName — otherwise §15b is vacuous');
    });
});

// ─── 16 — #B204: the reconnect classifier must not throw when the SDK exports no `Error` ─
/**
 * `lib/connector.v4.js` / `lib/connector.v3.js` — the `gina.onError` reconnect
 * classifier tests `err instanceof couchbase.Error`, but no supported couchnode
 * (3.x/4.x) exports a bare `Error` class (verified on a real 4.1.3 `dist/errors.js`:
 * `Error` undefined, `CouchbaseError` present among 82 error classes). The
 * `instanceof` therefore throws `TypeError: Right-hand side of 'instanceof' is not
 * an object` — and because the SDK-class arm is evaluated FIRST, the
 * shutdown-bucket message arm (which needs no SDK class) was unreachable too, so
 * the classifier could not classify anything by any route.
 *
 * Fix shape (#B204, deliberately NOT an activation): guard each `instanceof`
 * operand on the class existing. Under every supported SDK the guarded arms stay
 * false (modern errors carry no numeric `.code`), the message arm becomes
 * evaluable as its author intended, and nothing that never ran begins running —
 * the reconnect machinery's reachability on modern SDKs is unchanged in practice
 * (the SDK-2 message string greps 0 in the 4.1.3 dist JS, `timeout` firing as
 * control).
 *
 * Dispatch note pinned nowhere else: these listeners only ever fire under 4-arg
 * (Express-engine) error invocation; isaac's dispatchers invoke middlewares
 * 3-arg, so the arity shim sets `error = false` and the emit never happens.
 */
describe('16 - #B204: reconnect classifier is guarded (shipped bytes, both files)', function() {

    var FILES = {
        v4: path.join(FW, 'core/connectors/couchbase/lib/connector.v4.js'),
        v3: path.join(FW, 'core/connectors/couchbase/lib/connector.v3.js')
    };
    var srcs = {};
    before(function() {
        for (var k in FILES) { srcs[k] = fs.readFileSync(FILES[k], 'utf8'); }
    });

    /** Extract the primary classifier condition (the code-16 `if`). */
    function cond16(src) {
        var i = src.indexOf('err instanceof couchbase.Error && err.code == 16');
        // pre-fix the instanceof leads; post-fix a guard precedes it on the same
        // expression — anchor on the stable inner text, then widen to the `if (`.
        assert.ok(i > -1, 'code-16 arm must be found');
        var open = src.lastIndexOf('if (', i);
        var close = src.indexOf(') {', i);
        assert.ok(open > -1 && close > open, 'the if(...) must bracket the arm');
        return src.slice(open + 'if ('.length, close);
    }

    /** Extract the else-if (code-23) condition — skip the commented twin. */
    function cond23(src) {
        var i = src.indexOf('} else if (');
        while (i > -1 && src.slice(i, src.indexOf(') {', i)).indexOf('err.code == 23') === -1) {
            i = src.indexOf('} else if (', i + 1);
        }
        assert.ok(i > -1, 'code-23 else-if must be found');
        return src.slice(i + '} else if ('.length, src.indexOf(') {', i));
    }

    function drive(condSrc, couchbase, err) {
        var fn = new Function('couchbase', 'err', 'self', 'return (' + condSrc + ');');
        return fn(couchbase, err, { reconnected: false, reconnecting: false });
    }

    it('§16a — extraction grabbed real conditions in BOTH files (anti-vacuity)', function() {
        for (var k in srcs) {
            var c16 = cond16(srcs[k]), c23 = cond23(srcs[k]);
            assert.ok(c16.indexOf('instanceof') > -1, k + ': code-16 arm carries the instanceof');
            assert.ok(c16.indexOf('shutdown bucket') > -1, k + ': message arm is in the same condition');
            assert.ok(c23.indexOf('err.code == 23') > -1, k + ': code-23 arm found (not the comment)');
        }
    });

    it('§16b — SOURCE PIN: all four live sites carry the class-existence guard', function() {
        for (var k in srcs) {
            var code = srcs[k].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            var m = code.match(/typeof\s*\(\s*couchbase\.Error\s*\)\s*==+\s*'function'\s*&&\s*err instanceof couchbase\.Error/g) || [];
            assert.equal(m.length, 2, k + ': both live instanceof sites must be guarded, found ' + m.length);
            // anti-vacuity for the strip
            assert.ok(code.indexOf('instanceof couchbase.Error') > -1, k + ': control — the sites survive the strip');
        }
    });

    it('§16c — executed: a no-`Error` SDK no longer throws, and the message arm is evaluable', function() {
        var SDK = { CouchbaseError: class CouchbaseError extends Error {} }; // real 4.1.3 shape
        for (var k in srcs) {
            var c = cond16(srcs[k]);
            assert.equal(drive(c, SDK, Object.assign(new Error('net'), { code: 16 })), false,
                k + ': code-16 plain error classifies false (arm guarded, not matched)');
            assert.equal(drive(c, SDK, new Error('cannot perform operations on a shutdown bucket')), true,
                k + ': the message arm is reachable, as its author intended');
        }
    });

    it('§16d — CONTROL: an SDK that DOES export `Error` keeps SDK-2 semantics (green pre- and post-fix)', function() {
        var SDK = { Error: class CbError extends Error {} };
        for (var k in srcs) {
            assert.equal(drive(cond16(srcs[k]), SDK,
                Object.assign(new SDK.Error('net'), { code: 16 })), true, k + ': code 16 still classifies');
            assert.equal(drive(cond23(srcs[k]), SDK,
                Object.assign(new SDK.Error('t/o'), { code: 23 })), true, k + ': code 23 still classifies');
        }
    });

    it('§16e — executed: the code-23 else-if no longer throws on a no-`Error` SDK', function() {
        var SDK = { CouchbaseError: class CouchbaseError extends Error {} };
        for (var k in srcs) {
            assert.equal(drive(cond23(srcs[k]), SDK, Object.assign(new Error('t/o'), { code: 23 })), false,
                k + ': guarded arm evaluates false instead of throwing');
        }
    });
});
