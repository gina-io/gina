'use strict';
/**
 * #RWATCH — server wiring for the stale built-release watch (slice 2b).
 *
 * Source pins + pure-logic replicas over core/server.js, core/server.isaac.js
 * and core/gna.js: the boot-init hard gates, the in-flight gauge hooks (both
 * engines), the three /_gina/release/* endpoints (methods + admin gate +
 * isActive() gating + SSE closer registration — identical across engines),
 * the gina.registerBusyProbe export and the two config surfaces.
 *
 * The SERVICE behavior itself is covered behaviorally in
 * test/lib/release-watch-service.test.js (state machine, pipeline, idle gate)
 * and test/lib/release-watch.test.js (primitives); the S2c live smoke drives
 * the real endpoints end to end on a booted bundle.
 *
 * Run: node --test test/core/server-release-watch.test.js
 */

var assert = require('node:assert');
var { describe, it } = require('node:test');
var fs     = require('fs');
var path   = require('path');

var FW = require('../fw');

var SRV    = fs.readFileSync(FW + '/core/server.js', 'utf8');
var ISAAC  = fs.readFileSync(FW + '/core/server.isaac.js', 'utf8');
var GNA    = fs.readFileSync(FW + '/core/gna.js', 'utf8');
var TYPES  = fs.readFileSync(path.join(__dirname, '../../types/index.d.ts'), 'utf8');
var SCHEMA = fs.readFileSync(path.join(__dirname, '../../schema/settings.json'), 'utf8');
var TPL    = fs.readFileSync(FW + '/core/template/conf/settings.json', 'utf8');

/**
 * Slices an engine source down to its /_gina/release/* block.
 * Anchored on the block's banner comment and the next endpoint's banner —
 * structural anchors, not byte offsets.
 * @param {string} src
 * @param {string} endAnchor
 * @returns {string}
 */
function releaseBlock(src, endAnchor) {
    var start = src.indexOf('/_gina/release/* — stale built-release watch');
    assert.ok(start > -1, 'release endpoint banner expected');
    var end = src.indexOf(endAnchor, start);
    assert.ok(end > start, 'end anchor `' + endAnchor + '` expected after the release block');
    return src.substring(start, end);
}


describe('server-release-watch §01 — boot init (server.js)', function() {

    it('01.01 — init is wired, and BEFORE the `configured` emit', function() {
        var initIdx = SRV.indexOf('lib.releaseWatch.init(');
        var emitIdx = SRV.indexOf("self.emit('configured'");
        assert.ok(initIdx > -1, 'lib.releaseWatch.init( expected in server.js');
        assert.ok(emitIdx > -1);
        assert.ok(initIdx < emitIdx, 'the release-watch init must run before the configured emit');
    });

    it('01.02 — hard gates: local scope AND non-dev AND strict enabled === true', function() {
        var blkStart = SRV.indexOf('#RWATCH — stale built-release watch');
        var blkEnd   = SRV.indexOf("self.emit('configured'");
        var blk = SRV.substring(blkStart, blkEnd);
        assert.ok(/\/\^true\$\/i\.test\(process\.env\.NODE_SCOPE_IS_LOCAL\)/.test(blk), 'local-scope gate expected');
        assert.ok(/!\s*\/\^true\$\/i\.test\(process\.env\.NODE_ENV_IS_DEV\)/.test(blk), 'non-dev gate expected');
        assert.ok(blk.indexOf('_rwConf.enabled === true') > -1, 'strict enabled === true gate expected (fail-closed)');
    });

    it('01.03 — srcRoot resolves from the manifest src with the build-tree consistency warn', function() {
        assert.ok(SRV.indexOf('requireJSON(_rwManifestPath)') > -1, 'manifest read via requireJSON expected');
        assert.ok(SRV.indexOf('differs from the build source tree') > -1, 'srcRoot-vs-bundlesPath divergence warn expected');
        assert.ok(/getContext\('gina'\)\.project\.path/.test(SRV), 'project root via getContext expected');
    });

    it('01.04 — the flush seam is the /_gina/cache/clear idiom, resolved lazily', function() {
        assert.ok(SRV.indexOf('_rwFlushView.from(self.instance._cached)') > -1);
        assert.ok(SRV.indexOf('_rwFlushView.clear(bundle)') > -1);
        assert.ok(/httpServer\s*:\s*engine\.instance/.test(SRV), 'the engine instance must be handed to the service for the drain');
    });

    it('01.05 — init is NON-FATAL (an opt-in watch must never break a boot)', function() {
        assert.ok(/catch \(rwInitErr\)/.test(SRV));
        assert.ok(SRV.indexOf('[releaseWatch] init skipped') > -1);
    });
});


describe('server-release-watch §02 — in-flight gauge hooks (both engines)', function() {

    [ ['server.js', SRV], ['server.isaac.js', ISAAC] ].forEach(function(pair) {
        var name = pair[0], src = pair[1];

        it('02 — ' + name + ': isActive()-gated trackRequest wired to finish AND close, after the metrics hook', function() {
            var gaugeIdx = src.indexOf('lib.releaseWatch.trackRequest(request.url)');
            assert.ok(gaugeIdx > -1, 'trackRequest expected in ' + name);
            assert.strictEqual(src.match(/lib\.releaseWatch\.trackRequest\(/g).length, 1, 'exactly one gauge site per engine');
            var back = src.substring(gaugeIdx - 400, gaugeIdx);
            assert.ok(back.indexOf('lib.releaseWatch.isActive()') > -1, 'gauge must be isActive()-gated');
            var fwd = src.substring(gaugeIdx, gaugeIdx + 300);
            assert.ok(fwd.indexOf("response.on('finish', _rwDone)") > -1, 'finish wire expected');
            assert.ok(/response\.on\('close',\s+_rwDone\)/.test(fwd), 'close wire expected (idempotent finisher)');
            var metricsIdx = src.indexOf('lib.metrics.recordRequest(');
            assert.ok(metricsIdx > -1 && metricsIdx < gaugeIdx, 'gauge sits after the metrics hook (sibling block)');
        });
    });
});


describe('server-release-watch §03 — /_gina/release/* endpoints (both engines, identical contract)', function() {

    var srvBlk   = releaseBlock(SRV, '/_gina/instrument');
    var isaacBlk = releaseBlock(ISAAC, '/_gina/jobs/:id');

    [ ['server.js', srvBlk], ['server.isaac.js', isaacBlk] ].forEach(function(pair) {
        var name = pair[0], blk = pair[1];

        it('03.01 — ' + name + ': every endpoint is isActive()-gated (absent surface when the service is not armed)', function() {
            assert.ok((blk.match(/lib\.releaseWatch\.isActive\(\)/g) || []).length >= 3, 'all three endpoints gate on isActive()');
        });

        it('03.02 — ' + name + ': methods — status GET, rebuild POST, events GET', function() {
            var statusIdx  = blk.indexOf('release\\/status$');
            var rebuildIdx = blk.indexOf('release\\/rebuild(\\?.*)?$');
            var eventsIdx  = blk.indexOf('release\\/events$');
            assert.ok(statusIdx > -1 && rebuildIdx > -1 && eventsIdx > -1, 'all three URL regexes expected');
            assert.ok(blk.lastIndexOf("=== 'GET'", statusIdx) > -1, 'status is GET');
            var rebuildBack = blk.substring(statusIdx, rebuildIdx);
            assert.ok(rebuildBack.indexOf("=== 'POST'") > -1, 'rebuild is POST (a rebuild is a mutation)');
            var eventsBack = blk.substring(rebuildIdx, eventsIdx);
            assert.ok(eventsBack.indexOf("=== 'GET'") > -1, 'events is GET');
        });

        it('03.03 — ' + name + ': all three are admin-gated with the canonical 403 deny', function() {
            assert.strictEqual((blk.match(/lib\.admin\.isClientAllowed\(request\)/g) || []).length, 3, 'one admin gate per endpoint');
            ['status', 'rebuild', 'events'].forEach(function(ep) {
                assert.ok(blk.indexOf('/_gina/release/' + ep + ': client IP not in app.json admin.allowFrom') > -1,
                    'canonical deny message expected for ' + ep);
            });
        });

        it('03.04 — ' + name + ': rebuild dispatch — force-on-waiting opens the gate; a rejected rebuild is 409', function() {
            assert.ok(blk.indexOf('[?&]restart=(auto|skip|force)') > -1, 'the restart-param regex expected');
            assert.ok(blk.indexOf('lib.releaseWatch.forceRestartGate()') > -1);
            assert.ok(/requestRebuild\(\{ restart: _rwRestart, requestedBy: 'operator' \}\)/.test(blk));
            assert.ok(/409/.test(blk), 'busy/inactive rebuild answers 409');
        });

        it('03.05 — ' + name + ': the SSE stream subscribes, sends an initial status frame, and registers a self-removing closer', function() {
            assert.ok(blk.indexOf('lib.releaseWatch.subscribe(_rwSseSend)') > -1);
            assert.ok(blk.indexOf("_rwSseSend({ type: 'status', data: lib.releaseWatch.getStatus(), at: Date.now() })") > -1,
                'initial status frame expected');
            assert.ok(blk.indexOf('process.gina._sseConnections.add(_rwSseClose)') > -1, 'closer registered for the SIGTERM/restart drain');
            assert.ok(blk.indexOf('process.gina._sseConnections.delete(_rwSseClose)') > -1, 'closer self-removes');
            assert.ok(blk.indexOf('_rwUnsubscribe()') > -1, 'the closer unsubscribes from the service stream');
        });
    });

    it('03.06 — isaac mirrors keep the dual HTTP/2 / HTTP/1.1 idiom + the X-Powered-By wrap', function() {
        assert.ok((isaacBlk.match(/_setPoweredByHeader\(/g) || []).length >= 6, 'every isaac response wraps _setPoweredByHeader');
        assert.ok((isaacBlk.match(/response\.stream\.respond\(/g) || []).length >= 5, 'HTTP/2 fast-path expected on the isaac mirrors');
    });
});


describe('server-release-watch §04 — rebuild dispatch replica (pure logic)', function() {

    /**
     * Verbatim-lifted replica of both engines' rebuild dispatch:
     * parse ?restart=, route force-on-waiting to the gate, everything else to
     * requestRebuild, 409 on a rejected request.
     * @param {string} url
     * @param {(object|null)} status - getStatus() snapshot
     * @param {object} api - { forceRestartGate, requestRebuild }
     * @returns {{code:number, body:object}}
     */
    function dispatchRebuild(url, status, api) {
        var _rwRestartMatch = url.match(/[?&]restart=(auto|skip|force)\b/i);
        var _rwRestart      = _rwRestartMatch ? _rwRestartMatch[1].toLowerCase() : 'auto';
        if ( _rwRestart === 'force' && status && status.action && status.action.state === 'waiting' ) {
            return { code: 200, body: { accepted: true, forcedGate: api.forceRestartGate() } };
        }
        var _rwResult = api.requestRebuild({ restart: _rwRestart, requestedBy: 'operator' });
        return { code: _rwResult.accepted ? 200 : 409, body: _rwResult };
    }

    /** @returns {{api:object, calls:object}} recorder api */
    function recorder(accepted) {
        var calls = { force: 0, rebuild: [] };
        return {
            calls : calls,
            api   : {
                forceRestartGate : function() { calls.force++; return true; },
                requestRebuild   : function(opts) { calls.rebuild.push(opts); return { accepted: accepted, reason: accepted ? null : 'busy' }; }
            }
        };
    }

    it('04.01 — the replica regex is the one both engines ship (source-consistency pin)', function() {
        assert.ok(SRV.indexOf('[?&]restart=(auto|skip|force)') > -1);
        assert.ok(ISAAC.indexOf('[?&]restart=(auto|skip|force)') > -1);
    });

    it('04.02 — no param defaults to restart:auto', function() {
        var r = recorder(true);
        var out = dispatchRebuild('/_gina/release/rebuild', null, r.api);
        assert.strictEqual(out.code, 200);
        assert.deepStrictEqual(r.calls.rebuild, [ { restart: 'auto', requestedBy: 'operator' } ]);
    });

    it('04.03 — ?restart=skip and ?restart=force thread through (case-insensitive)', function() {
        var r = recorder(true);
        dispatchRebuild('/_gina/release/rebuild?restart=skip', null, r.api);
        dispatchRebuild('/_gina/release/rebuild?restart=FORCE', null, r.api);
        assert.deepStrictEqual(r.calls.rebuild.map(function(c) { return c.restart; }), ['skip', 'force']);
        assert.strictEqual(r.calls.force, 0, 'force with NO waiting gate starts a force-policy pipeline, not a gate open');
    });

    it('04.04 — force against a WAITING gate opens the gate instead of starting a pipeline', function() {
        var r = recorder(true);
        var out = dispatchRebuild('/_gina/release/rebuild?restart=force', { action: { state: 'waiting' } }, r.api);
        assert.strictEqual(out.code, 200);
        assert.deepStrictEqual(out.body, { accepted: true, forcedGate: true });
        assert.strictEqual(r.calls.force, 1);
        assert.deepStrictEqual(r.calls.rebuild, [], 'no new pipeline while one waits');
    });

    it('04.05 — force against a BUILDING action falls through to requestRebuild (which rejects busy → 409)', function() {
        var r = recorder(false);
        var out = dispatchRebuild('/_gina/release/rebuild?restart=force', { action: { state: 'building' } }, r.api);
        assert.strictEqual(out.code, 409);
        assert.strictEqual(out.body.reason, 'busy');
        assert.strictEqual(r.calls.force, 0);
    });

    it('04.06 — a rejected rebuild answers 409 with the reason', function() {
        var r = recorder(false);
        var out = dispatchRebuild('/_gina/release/rebuild', null, r.api);
        assert.strictEqual(out.code, 409);
        assert.deepStrictEqual(out.body, { accepted: false, reason: 'busy' });
    });
});


describe('server-release-watch §05 — public export + config surfaces', function() {

    it('05.01 — gna exports registerBusyProbe as a direct module-function reference', function() {
        assert.ok(GNA.indexOf('gna.registerBusyProbe = lib.releaseWatch.registerBusyProbe;') > -1,
            'direct reference expected (no `this` in the implementation — safe detached)');
    });

    it('05.02 — the types namespace declares it (the two-way parity gate arbitrates the pair)', function() {
        assert.ok(/^    function registerBusyProbe\(name: string, fn: /m.test(TYPES),
            '4-space namespace function decl expected (types-runtime-parity §02 shape)');
    });

    it('05.03 — schema: server.releaseWatch is a closed object with the notify|auto enum', function() {
        var schema = JSON.parse(SCHEMA);
        var rw = schema.properties.server.properties.releaseWatch;
        assert.ok(rw, 'schema entry expected');
        assert.strictEqual(rw.additionalProperties, false, 'fixed key set — closed object');
        assert.deepStrictEqual(rw.properties.mode.enum, ['notify', 'auto']);
        assert.strictEqual(rw.properties.enabled.type, 'boolean');
        assert.ok(/fail-closed|disabled by default/i.test(rw.description), 'the description states the fail-closed default');
    });

    it('05.04 — settings template ships the key ACTIVE with the fail-closed default', function() {
        var idx = TPL.indexOf('"releaseWatch": {');
        assert.ok(idx > -1, 'active releaseWatch key expected in the server block');
        var blk = TPL.substring(idx, idx + 220);
        assert.ok(blk.indexOf('"enabled": false') > -1, 'fail-closed default');
        assert.ok(blk.indexOf('"mode": "notify"') > -1);
        assert.ok(blk.indexOf('"debounceMs": 750') > -1);
        assert.ok(blk.indexOf('"reconcileIntervalMs": 0') > -1);
        // inside the server block, before its closing sibling key
        var serverIdx = TPL.indexOf('"server":');
        var uploadIdx = TPL.indexOf('"upload":');
        assert.ok(serverIdx < idx && idx < uploadIdx, 'releaseWatch must live inside the server block');
    });
});


describe('server-release-watch §06 — arc review fixes (RW-F8 gauge double-count, RW-F9 endpoint anchor, riders)', function() {

    // RW-F8 — under the isaac engine a routed request runs BOTH the engine's
    // single server.on('request') listener AND server.js's onInstance (invoked
    // as that listener's `cb`), so an unguarded gauge wires trackRequest twice
    // on one response. Self-balancing (both finishers fire → back to 0) but it
    // inflates the reported inFlight to 2 while the request is live. A first-seer
    // `request._rwTracked` claim makes the count exactly-once on either engine.
    [ ['server.js', SRV], ['server.isaac.js', ISAAC] ].forEach(function(pair) {
        var name = pair[0], src = pair[1];

        it('06.01 — ' + name + ': the gauge is first-seer guarded via request._rwTracked (exactly-once across the isaac double-dispatch)', function() {
            var gaugeIdx = src.indexOf('lib.releaseWatch.trackRequest(request.url)');
            assert.ok(gaugeIdx > -1);
            var win = src.substring(gaugeIdx - 500, gaugeIdx + 200);
            assert.ok(win.indexOf('!request._rwTracked') > -1, 'the gauge gate must claim first-seer via && !request._rwTracked');
            assert.ok(win.indexOf('request._rwTracked = true') > -1, 'the gauge must set the claim flag before counting');
            // the claim SET must precede the count (so the second hook site skips)
            assert.ok(src.indexOf('request._rwTracked = true') < gaugeIdx, 'the claim flag is set before trackRequest');
        });
    });

    it('06.02 — first-seer claim: a request wired by two hook sites counts exactly once (double-wire replica + subtract)', function() {
        // verbatim replica of trackRequest's idempotent finisher + the _rwTracked claim
        var inFlight = 0;
        function trackRequest() {
            inFlight++;
            var done = false;
            return function() { if (done) return; done = true; if (inFlight > 0) inFlight--; };
        }
        function guardedHook(request, dones, active) {
            if (active && !request._rwTracked) {
                request._rwTracked = true;
                dones.push(trackRequest());
            }
        }
        // isaac path: listener hook, then onInstance hook, on the SAME request
        var req = {}, dones = [];
        guardedHook(req, dones, true);   // isaac listener claims
        guardedHook(req, dones, true);   // onInstance — must skip
        assert.strictEqual(inFlight, 1, 'guarded: counted once despite two hook invocations');
        assert.strictEqual(dones.length, 1, 'only one finisher wired');
        dones.forEach(function(d) { d(); });
        assert.strictEqual(inFlight, 0, 'settles back to zero on finish');

        // subtract: WITHOUT the claim, the two hook sites double-count
        inFlight = 0;
        function unguardedHook(dones2, active) {
            if (active) { dones2.push(trackRequest()); }
        }
        var dones2 = [];
        unguardedHook(dones2, true);
        unguardedHook(dones2, true);
        assert.strictEqual(inFlight, 2, 'subtract: unguarded double-count inflates the reported inFlight to 2');
    });

    // RW-F9 — the release endpoint regexes were UNanchored (/\/_gina\/…$/), so a
    // crafted /foo/_gina/release/events matched the SSE handler while the
    // ^-anchored isControlPath gauge-exclusion did NOT exclude it — the SSE
    // response would be counted and never fire `finish`, deadlocking the idle
    // gate. Anchoring the endpoint regexes at ^ makes the SSE-match set a strict
    // SUBSET of the (^-anchored) exclusion set: any URL that opens the stream is
    // guaranteed excluded.
    [ ['server.js', releaseBlock(SRV, '/_gina/instrument')], ['server.isaac.js', releaseBlock(ISAAC, '/_gina/jobs/:id')] ].forEach(function(pair) {
        var name = pair[0], blk = pair[1];

        it('06.03 — ' + name + ': the three release endpoint regexes are ^-anchored (no crafted-prefix SSE deadlock)', function() {
            assert.ok(blk.indexOf('/^\\/_gina\\/release\\/status$/') > -1, 'status regex must be ^-anchored');
            assert.ok(blk.indexOf('/^\\/_gina\\/release\\/rebuild(\\?.*)?$/') > -1, 'rebuild regex must be ^-anchored');
            assert.ok(blk.indexOf('/^\\/_gina\\/release\\/events$/') > -1, 'events regex must be ^-anchored');
        });
    });

    it('06.04 — RW-F9 replica: a ^-anchored SSE match is a subset of the ^-anchored exclusion (no gauge-counted SSE)', function() {
        // isControlPath (lib/release-watch): ^-anchored on the query-stripped path
        function isControlPath(url) {
            if (typeof url !== 'string') return false;
            return /^\/_gina\//.test(url.split('?')[0]);
        }
        // the anchored endpoint matcher
        function matchesEvents(url) { return /^\/_gina\/release\/events$/i.test(url); }
        // canonical: matches AND is excluded → no deadlock
        assert.ok(matchesEvents('/_gina/release/events'));
        assert.ok(isControlPath('/_gina/release/events'), 'canonical SSE excluded from the gauge');
        // crafted prefix: with the anchor it NO LONGER matches → falls through to
        // routing (404, fires finish) instead of opening an uncounted SSE
        assert.ok(!matchesEvents('/foo/_gina/release/events'), 'crafted-prefix URL no longer opens the SSE handler');
        // subtract: the OLD unanchored matcher WOULD have matched the crafted URL
        // while isControlPath excluded neither → the deadlock this fix closes
        function matchesEventsUnanchored(url) { return /\/_gina\/release\/events$/i.test(url); }
        assert.ok(matchesEventsUnanchored('/foo/_gina/release/events'), 'subtract: the unanchored matcher opened the crafted SSE');
        assert.ok(!isControlPath('/foo/_gina/release/events'), 'subtract: the crafted URL was NOT gauge-excluded → deadlock');
    });

    it('06.05 — RW-rider: the boot-init warns on a truthy-but-not-boolean-true `enabled` (string "true" no longer a silent no-op)', function() {
        var blk = SRV.substring(SRV.indexOf('#RWATCH — stale built-release watch'), SRV.indexOf("self.emit('configured'"));
        assert.ok(blk.indexOf('else if ( _rwConf.enabled )') > -1, 'a non-strict-true enabled must be caught');
        assert.ok(/expected the boolean true/.test(blk), 'the warn names the fail-closed expectation');
        // the strict === true arm (fail-closed default) is preserved
        assert.ok(blk.indexOf('_rwConf.enabled === true') > -1, 'the strict === true arm is preserved');
    });

    it('06.06 — RW-rider: server.js release 403s carry cache-control (cross-engine parity with the isaac mirrors)', function() {
        var blk = releaseBlock(SRV, '/_gina/instrument');
        ['status', 'rebuild', 'events'].forEach(function(ep) {
            var denyIdx = blk.indexOf('/_gina/release/' + ep + ': client IP not in app.json admin.allowFrom');
            assert.ok(denyIdx > -1, ep + ' deny message expected');
            var back = blk.substring(Math.max(0, denyIdx - 300), denyIdx);
            assert.ok(back.indexOf("setHeader('cache-control'") > -1, ep + ' 403 must set cache-control');
        });
    });
});
