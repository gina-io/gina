'use strict';
/**
 * #B715 — on the isaac engine, the maintenance gate must not stand before a `/_gina/*`
 * endpoint that only core/server.js answers.
 *
 * isaac's gate sits below isaac's own `/_gina/*` handlers and above the hand-off to
 * core/server.js, whose /_gina band sits above its twin gate. An endpoint core/server.js
 * answers and isaac does not — `/_gina/storage/stats`, `/_gina/storage/gc`,
 * `/_gina/storage/verify` since 0.6.7 — therefore answered isaac's 503 for a whole
 * maintenance window on isaac only. The fix names those paths in `_isLeftToServerJs`, which the
 * gate consults last.
 *
 * This file is the parity pin that keeps the list in step: it extracts every `/_gina/`
 * endpoint matcher above each engine's gate banner and asserts that every endpoint
 * core/server.js answers is either answered by isaac above its gate or left to core/server.js.
 * A future core/server.js-only endpoint turns it red. It also executes the extracted
 * predicate. The live twin is
 * test/integration/container-boot-maintenance-left-to-server-b715.test.js.
 *
 * Seams — run the whole file against other bytes (red-first, no tree revert):
 *   GINA_B715_SERVER_SRC=<core/server.js copy>  GINA_B715_ISAAC_SRC=<core/server.isaac.js copy>
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW = require('../fw');

var SERVER = fs.readFileSync(process.env.GINA_B715_SERVER_SRC || path.join(FW, 'core/server.js'), 'utf8');
var ISAAC  = fs.readFileSync(process.env.GINA_B715_ISAAC_SRC  || path.join(FW, 'core/server.isaac.js'), 'utf8');

/** The banner both engines open their maintenance gate with. */
var GATE_BANNER = '#MAINT1 — maintenance gate';

/** The predicate's declaration in core/server.isaac.js. */
var PREDICATE_DECL = 'function _isLeftToServerJs(url) {';

/** The gate condition, with the predicate consulted last. */
var GATE_CONDITION = 'if ( _mtState && lib.maintenance.isActive(_mtState) && !_isLeftToServerJs(request.url) ) {';

/**
 * A `/_gina/` regex literal applied with `.test(…)` to `request.url`, to its query-free path
 * (`request.url.split('?')[0]` in core/server.js, `_routingPath` in isaac — #P48's routing map)
 * or to the #B709 control path, or passed to `request.url.match(…)` (the jobs handler).
 */
var MATCHER_RES = [
    /\/((?:\\\/|[^\/\n])+)\/[dgimsuvy]*\.test\((?:request\.url(?:\.split\('\?'\)\[0\])?|_ginaCtlPath|_routingPath)\)/g,
    /request\.url\.match\(\/((?:\\\/|[^\/\n])+)\/[dgimsuvy]*\)/g
];

/**
 * The source above the gate banner — where a handler has to sit to answer during a window.
 * @param {string} src engine source
 * @returns {string}
 */
function aboveGate(src) {
    var at = src.indexOf(GATE_BANNER);
    assert.ok(at > -1, 'the gate banner must be present');
    assert.equal(src.indexOf(GATE_BANNER, at + 1), -1, 'the gate banner must be unique');
    return src.slice(0, at);
}

/**
 * The endpoint path a matcher regex names, unescaped, without a trailing slash
 * (`storage/stats`, `health/check`, `jobs`, `assets/routing.json`); `null` for the bare
 * `/_gina/` family match of the cross-origin guard.
 * @param {string} source regex source
 * @returns {string|null}
 */
function endpointOf(source) {
    var m = source.match(/_gina\\\/((?:[A-Za-z0-9_-]|\\\/|\\\.)+)/);
    if ( !m ) { return null; }
    return m[1].replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\/+$/, '');
}

/**
 * Every endpoint named by a matcher in `region`.
 * @param {string} region source text
 * @returns {string[]} sorted, unique
 */
function endpoints(region) {
    var out = {};
    MATCHER_RES.forEach(function (re) {
        var m;
        re.lastIndex = 0;
        while ( (m = re.exec(region)) !== null ) {
            if ( m[1].indexOf('_gina') < 0 ) { continue; }
            var ep = endpointOf(m[1]);
            if ( ep ) { out[ep] = true; }
        }
    });
    return Object.keys(out).sort();
}

/**
 * The predicate's source text, declaration to closing brace, or `null` when absent.
 * @param {string} src core/server.isaac.js source
 * @returns {string|null}
 */
function predicateText(src) {
    var at = src.indexOf(PREDICATE_DECL);
    if ( at < 0 ) { return null; }
    var end = src.indexOf('\n}\n', at);
    return ( end > -1 ) ? src.slice(at, end + 2) : null;
}

/**
 * The endpoints the predicate leaves to core/server.js (its `'/_gina/…'` literals).
 * @param {string} src core/server.isaac.js source
 * @returns {string[]} sorted
 */
function leftToServer(src) {
    var text = predicateText(src);
    if ( !text ) { return []; }
    var re = /'\/_gina\/([^'?]+)'/g, m, out = [];
    while ( (m = re.exec(text)) !== null ) { out.push(m[1]); }
    return out.sort();
}

/**
 * Endpoints core/server.js answers that isaac neither answers above its gate nor leaves to
 * core/server.js.
 * @param {string} serverSrc core/server.js source
 * @param {string} isaacSrc  core/server.isaac.js source
 * @returns {string[]}
 */
function missing(serverSrc, isaacSrc) {
    var isaacEps = endpoints(aboveGate(isaacSrc));
    var left     = leftToServer(isaacSrc);
    return endpoints(aboveGate(serverSrc)).filter(function (ep) {
        return isaacEps.indexOf(ep) < 0 && left.indexOf(ep) < 0;
    });
}

/**
 * The predicate compiled from its own source text.
 * @returns {function(*):boolean}
 */
function compilePredicate() {
    var text = predicateText(ISAAC);
    assert.ok(text, 'core/server.isaac.js must declare `' + PREDICATE_DECL + '`');
    return new Function(text + '\nreturn _isLeftToServerJs;')();
}


describe('01 - the extraction (instrument arms)', function () {

    it('01.1  finds the endpoints core/server.js answers above its gate', function () {
        var eps = endpoints(aboveGate(SERVER));
        ['storage/stats', 'storage/gc', 'storage/verify', 'health/check', 'jobs', 'assets/routing.json',
         'maintenance', 'info', 'metrics', 'cache/stats', 'cache/clear', 'release/status'].forEach(function (ep) {
            assert.ok(eps.indexOf(ep) > -1, 'expected `' + ep + '` among ' + JSON.stringify(eps));
        });
    });

    it('01.2  finds isaac\'s handlers above its gate, and no storage handler among them', function () {
        var eps = endpoints(aboveGate(ISAAC));
        ['info', 'maintenance', 'health/check', 'jobs', 'assets/routing.json'].forEach(function (ep) {
            assert.ok(eps.indexOf(ep) > -1, 'expected `' + ep + '` among ' + JSON.stringify(eps));
        });
        ['storage/stats', 'storage/gc', 'storage/verify'].forEach(function (ep) {
            assert.equal(eps.indexOf(ep), -1, '`' + ep + '` is answered by core/server.js only');
        });
    });

    it('01.3  the check fires on a core/server.js endpoint isaac knows nothing about', function () {
        var at = SERVER.indexOf(GATE_BANNER);
        var synthetic = SERVER.slice(0, at)
            + "if ( /^\\/_gina\\/zz\\/new$/.test(request.url) ) { return response.end(); }\n"
            + SERVER.slice(at);
        assert.ok(missing(synthetic, ISAAC).indexOf('zz/new') > -1, 'a new core/server.js-only endpoint must be reported');
    });

    it('01.4  a handler BELOW isaac\'s gate does not count as isaac answering it', function () {
        var at = ISAAC.indexOf(GATE_BANNER);
        var synthetic = ISAAC.slice(0, at + GATE_BANNER.length)
            + "\nif ( /^\\/_gina\\/zz\\/new$/.test(request.url) ) { return response.end(); }\n"
            + ISAAC.slice(at + GATE_BANNER.length);
        var serverWithNew = SERVER.slice(0, SERVER.indexOf(GATE_BANNER))
            + "if ( /^\\/_gina\\/zz\\/new$/.test(request.url) ) { return response.end(); }\n"
            + SERVER.slice(SERVER.indexOf(GATE_BANNER));
        assert.ok(missing(serverWithNew, synthetic).indexOf('zz/new') > -1, 'only handlers above the gate cover an endpoint');
    });
});

describe('02 - the parity property', function () {

    it('02.1  every endpoint core/server.js answers is answered by isaac above its gate or left to core/server.js', function () {
        assert.deepEqual(missing(SERVER, ISAAC), []);
    });

    it('02.2  isaac leaves to core/server.js only endpoints core/server.js answers', function () {
        var left = leftToServer(ISAAC);
        assert.ok(left.length > 0, 'core/server.isaac.js must declare the paths it leaves to core/server.js');
        var serverEps = endpoints(aboveGate(SERVER));
        left.forEach(function (ep) {
            assert.ok(serverEps.indexOf(ep) > -1, '`/_gina/' + ep + '` is not answered by core/server.js');
        });
    });

    it('02.3  the gate consults the predicate, last, once', function () {
        var at = ISAAC.indexOf(GATE_CONDITION);
        assert.ok(at > ISAAC.indexOf(GATE_BANNER), 'the gate condition must follow the banner: ' + GATE_CONDITION);
        assert.equal(ISAAC.indexOf(GATE_CONDITION, at + 1), -1, 'one gate condition');
    });
});

describe('03 - the predicate', function () {

    it('03.1  lets the storage endpoints and the health check through, with or without a query', function () {
        var left = compilePredicate();
        ['/_gina/storage/stats', '/_gina/storage/gc', '/_gina/storage/verify', '/_gina/health/check',
         '/_gina/storage/stats?driver=main', '/_gina/storage/gc?dryRun=1', '/_gina/health/check?probe=1'].forEach(function (u) {
            assert.equal(left(u), true, u);
        });
    });

    it('03.2  keeps every other path behind the gate', function () {
        var left = compilePredicate();
        ['/_gina/info', '/_gina/maintenance', '/_gina/cache/clear', '/web/_gina/storage/stats', '/_GINA/storage/stats',
         '//_gina/storage/stats', '/_gina/storage/statsx', '/_gina/storage', '/_gina/health/checkup',
         '/?next=/_gina/storage/gc', '/', '/home'].forEach(function (u) {
            assert.equal(left(u), false, u);
        });
        [undefined, null, 42, {}].forEach(function (u) {
            assert.equal(left(u), false, String(u));
        });
    });
});
