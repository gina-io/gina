/**
 * #B211 — engine:"express" on Express 5: version-agnostic catch-all mount +
 * the request.query prototype-getter shadow + the declared supported range.
 *
 * Two independent Express-5 breakages, both measured live on express@5.2.1
 * (with an express@4.22.2 control) before the fix was designed:
 *   (1) `app.all('*')` throws at MOUNT time (path-to-regexp v8 rejects the
 *       bare-string wildcard) — exit 1 before listen(), the filed defect;
 *   (2) past the mount, gina's request pipeline assigns `request.query =`
 *       at 8 sites under 'use strict', and Express 5 defines `req.query` as
 *       a prototype GETTER — so every request dies with
 *       `TypeError: Cannot set property query ... which has only a getter`.
 *
 * Fix (gated 2026-08-15, both gate questions as recommended):
 *   - the catch-all pattern is ENGINE-CONDITIONAL: express mounts a RegExp
 *     `/(.*)/ ` — accepted AND live-dispatching `/`, `/web/`, deep paths on
 *     Express 4 and 5 — while isaac KEEPS the string `'*'`, because its
 *     request listener's dispatch gate is `path === '*' || path ==
 *     request.url` (server.isaac.js:2366): a RegExp there matches NOTHING
 *     and every request hangs (measured — a deterministic container-boot
 *     timeout on the first, unconditional-regex attempt);
 *   - the adapter shadows `query` on `app.request` with a writable own DATA
 *     property (no-op on 4, restores gina's owns-the-parse contract on 5)
 *     — since #B666 an ACCESSOR whose setter keeps that contract and whose
 *     getter materialises the engine parse (see express-query-b666.test.js);
 *   - the adapter logs the detected express version and WARNS (never refuses)
 *     outside the verified range >= 4 < 6.
 *
 * Express is consumer-provided by design (never a dependency, NEVER a
 * peerDependency — npm >= 7 auto-installs peers), so this suite cannot
 * require express: §03 replicates Express 5's getter shape in pure node to
 * pin the mechanism the fix depends on, and the LIVE A/B boot smoke on real
 * express 4 + 5 installs is the acceptance instrument (recorded in the
 * ledger entry, run per fix — not in CI).
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var ginaRoot = path.resolve(__dirname, '../..');
var version = require(ginaRoot + '/package.json').version;
var FW = path.join(ginaRoot, 'framework', 'v' + version);

var SERVER = fs.readFileSync(path.join(FW, 'core', 'server.js'), 'utf8');
var ADAPTER = fs.readFileSync(path.join(FW, 'core', 'server.express.js'), 'utf8');
var ISAAC = fs.readFileSync(path.join(FW, 'core', 'server.isaac.js'), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(function (l) { return !/^\s*\/\//.test(l); })
        .join('\n');
}
var SERVER_ST = stripComments(SERVER);
var ADAPTER_ST = stripComments(ADAPTER);

// ---------------------------------------------------------------------------
// 01 — server.js: the catch-all mount is a RegExp, not the bare string
// ---------------------------------------------------------------------------
describe('01 - server.js catch-all mount (#B211)', function () {

    it('strip validity: the stripped source still holds the mount site', function () {
        assert.ok(SERVER_ST.indexOf('self.instance.all(') > -1);
    });

    it('the catch-all pattern is engine-conditional: RegExp for express, the string for isaac', function () {
        assert.ok(SERVER_ST.indexOf("( /^express/.test(self.engine) ) ? /(.*)/ : '*'") > -1,
            'express needs the RegExp (v5 rejects the bare string at mount); isaac needs the ' +
            "string (its dispatch gate is path === '*' — a RegExp hangs every request)");
        assert.ok(SERVER_ST.indexOf('self.instance.all(catchAllPattern,') > -1,
            'the mount must take the engine-resolved pattern');
    });

    it("negative: no UNCONDITIONAL bare-string '*' mount remains in ACTIVE code", function () {
        // raw-guard: the pre-fix spelling survives in the `// was:` comment,
        // so a broken strip cannot pass this pin vacuously
        assert.ok(SERVER.indexOf("self.instance.all('*'") > -1,
            'raw-guard: the commented pre-fix shape should still document the change');
        assert.ok(SERVER_ST.indexOf("self.instance.all('*'") === -1,
            "ACTIVE code must not mount all('*') directly — it aborts the boot on Express 5");
    });

    it('the mount is unique — exactly one catch-all registration', function () {
        var n = SERVER_ST.split('self.instance.all(').length - 1;
        assert.equal(n, 1, 'expected exactly one self.instance.all( site, got ' + n);
    });
});

// ---------------------------------------------------------------------------
// 02 — server.express.js: query shadow + declared range
// ---------------------------------------------------------------------------
describe('02 - adapter query shadow + version range (#B211)', function () {

    it('shadows query on the per-app request prototype with an ACCESSOR whose setter keeps assignment alive (#B666)', function () {
        // #B666 realigned this pin (landing gate, 2026-09-25): the #B211 writable DATA
        // property became a get/set accessor — the setter stores a writable own
        // property, so the strict-mode pipeline assignments still work; the getter
        // materialises the engine's own parse on Express 5 (express-query-b666.test.js).
        assert.ok(ADAPTER_ST.indexOf("Object.defineProperty(app.request, 'query', queryAccessorDescriptor(app.request));") > -1,
            'the query shadow is what keeps the strict-mode pipeline assignments alive on Express 5');
        var start = ADAPTER_ST.indexOf('function queryAccessorDescriptor(');
        assert.ok(start > -1, 'the descriptor factory must exist');
        var block = ADAPTER_ST.slice(start, ADAPTER_ST.indexOf('\n}\n', start));
        assert.ok(/set:\s*function \(value\)/.test(block), 'the accessor must have a setter');
        assert.ok(/get:\s*function \(\)/.test(block), 'the accessor must have a getter');
        assert.ok(/configurable:\s*true/.test(block), 'the accessor must stay configurable');
    });

    it('reads and logs the detected express version with the supported range', function () {
        assert.ok(ADAPTER_ST.indexOf("require('express/package.json').version") > -1,
            'the adapter must read the consumer-resolved express version');
        assert.ok(ADAPTER_ST.indexOf('supported: >= 4 < 6') > -1,
            'the boot log must name the verified range');
    });

    it('out-of-range majors WARN and boot — never refuse (gate decision)', function () {
        assert.ok(ADAPTER_ST.indexOf('OUTSIDE the verified range') > -1,
            'the out-of-range warning must exist');
        var vblock = ADAPTER_ST.slice(
            ADAPTER_ST.indexOf('var expressVersion'),
            ADAPTER_ST.indexOf("Object.defineProperty(app.request, 'query'"));
        assert.ok(vblock.indexOf('process.exit') === -1 && vblock.indexOf('throw ') === -1,
            'the version block must neither exit nor throw — warn-not-refuse was the gated call');
    });

    it('negative: express is not promoted to a manifest dependency', function () {
        ['package.json', path.join('framework', 'v' + version, 'package.json')].forEach(function (m) {
            var pkg = JSON.parse(fs.readFileSync(path.join(ginaRoot, m), 'utf8'));
            ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].forEach(function (k) {
                assert.ok(!(pkg[k] && pkg[k].express),
                    m + ' must not declare express under ' + k +
                    ' — consumer-provided by design, and a peerDependency would auto-install under npm >= 7');
            });
        });
    });
});

// ---------------------------------------------------------------------------
// 03 — REPLICA: the Express 5 getter mechanism the fix depends on
// (pure node — the suite cannot require express; the live A/B smoke on real
//  installs is the acceptance instrument)
// ---------------------------------------------------------------------------
describe('03 - replica: prototype-getter assignment physics', function () {
    'use strict';

    function makeExpress5LikeProto() {
        // Express 5 lib/request.js: defineGetter(req, 'query', function query(){...})
        var proto = {};
        Object.defineProperty(proto, 'query', {
            configurable: true,
            enumerable: true,
            get: function () { return { fromGetter: true }; }
        });
        return proto;
    }

    it('strict-mode assignment through a getter-only prototype THROWS (the pre-fix per-request death)', function () {
        var req = Object.create(makeExpress5LikeProto());
        assert.throws(function () { req.query = undefined; }, TypeError);
    });

    it('the writable data-property shadow restores assignment (the #B211 shape — #B666 keeps its setter semantics behind an accessor)', function () {
        var proto = makeExpress5LikeProto();
        // app.request in express is Object.create(<proto with getter>) — the shadow
        // lands on that intermediate object, exactly as the adapter does it
        var appRequest = Object.create(proto);
        Object.defineProperty(appRequest, 'query', {
            value: undefined, writable: true, configurable: true, enumerable: false
        });
        var req = Object.create(appRequest);
        req.query = undefined;              // server.js:6040 shape
        req.query = { merged: true };       // server.js:6090 shape
        assert.deepEqual(req.query, { merged: true });
    });

    it('control: without the shadow the getter still answers (the replica can tell the two apart)', function () {
        var req = Object.create(makeExpress5LikeProto());
        assert.deepEqual(req.query, { fromGetter: true });
    });
});

// ---------------------------------------------------------------------------
// 04 — isaac: the dispatch gate REQUIRES the string pattern (tripwire)
// ---------------------------------------------------------------------------
describe("04 - isaac: the dispatch gate requires path === '*'", function () {

    it('server.all delegates to onPath with allowAll=true', function () {
        assert.ok(ISAAC.indexOf('onPath.call(this, path, cb, true)') > -1);
    });

    it("the request listener gates dispatch on path === '*' — the reason isaac keeps the string", function () {
        // TRIPWIRE: if this gate ever changes shape, re-evaluate whether the
        // engine-conditional mount in server.js can be simplified. It is the
        // line that made the first (unconditional-regex) #B211 attempt hang
        // every isaac request — bind OK, no response, deterministic.
        assert.ok(ISAAC.indexOf("if (path === '*' || path == request.url)") > -1,
            "isaac's dispatch gate moved or changed — re-verify the #B211 engine-conditional mount");
    });
});
