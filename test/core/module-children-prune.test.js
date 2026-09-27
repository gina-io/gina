/**
 * module-children-prune.test.js
 *
 * Dev-mode eviction leak guard.
 *
 * Per-request delete-and-re-require cycles (refreshCore() in the isaac engine,
 * refreshCoreDependencies() in the router) push a fresh Module onto the requiring
 * module's `children` array on every cache miss — Node only dedupes on cache
 * hits. Without pruning, long-lived parents accumulate dead Module instances
 * whose exports pin whole per-request graphs: measured ~1.8 MB of post-GC live
 * heap per request on a minimal dev bundle, heap-limit OOM (SIGABRT) at ~2400
 * requests.
 *
 * Locks:
 *   §01 server.isaac.js — pruneDeadModuleChildren defined + called at the END of
 *       refreshCore() (after the plugins re-require), with the cache-current
 *       filter predicate.
 *   §02 router.js — local copy defined + called inside refreshCoreDependencies()
 *       after the controller re-require.
 *   §03 pure-logic replica — eviction grows module.children; the shipped prune
 *       body keeps only cache-current instances and leaves exports functional.
 *       Includes the subtract case: without the prune, children grows unbounded.
 *   §04 lib/index.js — the #B32-residual fix: collection/merge/uuid/cache/archiver
 *       use plain require (not _require), so a gen-0 binding (server.isaac.js:34/:853)
 *       cannot accumulate dead children on a module the prune can't reach.
 *   §05 replica — a gen-0 parent retained OFF require.cache grows children every
 *       request despite the prune (the residual the require.cache walk misses);
 *       a resident (plain-require'd) child keeps it bounded. §04 locks the fix.
 *   §06 audit guard — lib/inherits has zero require() calls (#B32-residual
 *       completeness audit, 2026-06-16). inherits is the only HOT lib gen-0-captured
 *       AND invoked per-request by load-once modules (router.js / couchbase), so a
 *       zero-require body is what keeps those sites from reopening the residual; the
 *       pin trips if any require() is ever added there.
 */

var assert = require('assert');
var test = require('node:test');
var fs = require('fs');
var os = require('os');
var path = require('path');

var BASE = path.join(__dirname, '..', '..');
var FRAMEWORK_DIR = fs.readdirSync(path.join(BASE, 'framework'))
    .filter(function(d) { return /^v\d/.test(d); })
    .sort()
    .pop();
var ISAAC_PATH = path.join(BASE, 'framework', FRAMEWORK_DIR, 'core', 'server.isaac.js');
var ROUTER_PATH = path.join(BASE, 'framework', FRAMEWORK_DIR, 'core', 'router.js');
var ISAAC_SRC = fs.readFileSync(ISAAC_PATH, 'utf8');
var ROUTER_SRC = fs.readFileSync(ROUTER_PATH, 'utf8');

test('§01 server.isaac.js: pruneDeadModuleChildren is defined', function() {
    assert.ok(
        ISAAC_SRC.indexOf('var pruneDeadModuleChildren = function()') > -1,
        'server.isaac.js must define pruneDeadModuleChildren'
    );
});

test('§01 server.isaac.js: refreshCore() ends with the prune (after the plugins re-require)', function() {
    // Structural anchor: the plugins re-assignment is the last eviction step in
    // refreshCore(); the prune call must follow it within the same function body.
    var anchor = ISAAC_SRC.indexOf('.exports.plugins = freshPlugins;');
    assert.ok(anchor > -1, 'plugins re-require anchor not found');
    assert.match(
        ISAAC_SRC.slice(anchor),
        /^\.exports\.plugins = freshPlugins;[\s\S]{0,200}?pruneDeadModuleChildren\(\);/,
        'refreshCore() must call pruneDeadModuleChildren() after the plugins re-require'
    );
});

test('§01 server.isaac.js: prune keeps only cache-current children', function() {
    assert.match(
        ISAAC_SRC,
        /cached\.children = cached\.children\.filter\(function onPruneFilter\(child\) \{\s*return require\.cache\[child\.id\] === child;/,
        'prune predicate must keep only Modules still current in require.cache'
    );
});

test('§02 router.js: local pruneDeadModuleChildren copy is defined', function() {
    assert.ok(
        ROUTER_SRC.indexOf('var pruneDeadModuleChildren = function()') > -1,
        'router.js must define its local pruneDeadModuleChildren copy'
    );
});

test('§02 router.js: refreshCoreDependencies() prunes after the controller re-require', function() {
    var anchor = ROUTER_SRC.indexOf('SuperController = require(');
    assert.ok(anchor > -1, 'controller re-require anchor not found');
    assert.match(
        ROUTER_SRC.slice(anchor),
        /^SuperController = require\([\s\S]{0,400}?pruneDeadModuleChildren\(\);/,
        'refreshCoreDependencies() must call pruneDeadModuleChildren() after re-requiring the controller'
    );
});

test('§02 router.js: prune keeps only cache-current children', function() {
    assert.match(
        ROUTER_SRC,
        /cached\.children = cached\.children\.filter\(function onPruneFilter\(child\) \{\s*return require\.cache\[child\.id\] === child;/,
        'router copy must use the same cache-current predicate'
    );
});

test('§03 replica: eviction grows children unbounded; prune releases dead Modules, exports stay functional', function() {
    var tmpFile = path.join(os.tmpdir(), 'gina-prune-replica-' + process.pid + '.js');
    fs.writeFileSync(tmpFile, 'module.exports = { marker: "live", payload: new Array(100).fill("x") };');
    var resolved = require.resolve(tmpFile);
    var baseline = module.children.length;

    try {
        // Subtract case — the leak shape without the prune: every cache-miss
        // require pushes a fresh dead Module onto this module's children.
        for (var i = 0; i < 25; i++) {
            delete require.cache[resolved];
            require(tmpFile);
        }
        assert.strictEqual(
            module.children.length,
            baseline + 25,
            'delete-and-re-require must grow children by one dead Module per cycle (leak repro)'
        );

        // Cache-hit requires must NOT grow children (why prod is bounded).
        for (var j = 0; j < 25; j++) {
            require(tmpFile);
        }
        assert.strictEqual(
            module.children.length,
            baseline + 25,
            'cache-hit requires must not grow children (Node dedupes on hits)'
        );

        // Shipped prune body, replicated verbatim.
        var cacheIds = Object.keys(require.cache);
        for (var k = 0, len = cacheIds.length; k < len; k++) {
            var cached = require.cache[cacheIds[k]];
            if (cached && cached.children && cached.children.length > 0) {
                cached.children = cached.children.filter(function onPruneFilter(child) {
                    return require.cache[child.id] === child;
                });
            }
        }

        var survivors = module.children.filter(function(c) { return c.id === resolved; });
        assert.strictEqual(survivors.length, 1, 'exactly the cache-current Module must survive the prune');
        assert.strictEqual(
            module.children.length <= baseline + 1,
            true,
            'all dead Modules must be released from children'
        );
        assert.strictEqual(require(tmpFile).marker, 'live', 'exports must remain functional after pruning');
    } finally {
        delete require.cache[resolved];
        try { fs.unlinkSync(tmpFile); } catch (e) { /* best effort */ }
        module.children = module.children.filter(function(c) { return c.id !== resolved; });
    }
});

test('§04 lib/index.js: leaf/singleton libs use plain require, not _require (#B32-residual guard)', function() {
    var LIB_INDEX = path.join(BASE, 'framework', FRAMEWORK_DIR, 'lib', 'index.js');
    var SRC = fs.readFileSync(LIB_INDEX, 'utf8');
    // collection/merge/uuid are new'd per request from gen-0 bindings held by
    // load-once modules (server.isaac.js:34 `const Collection = lib.Collection`,
    // used at :853). _require evicts them every refreshCore(), so each per-request
    // `new Collection()` pushes a dead merge/uuid Module onto the gen-0
    // (evicted-but-retained) collection Module — which pruneDeadModuleChildren()
    // never reaches (require.cache keys only). cache/archiver are the `new X()`
    // singletons that must not churn. Plain require keeps them resident (cache-hit,
    // Node dedupes). Flipping any back to _require reintroduces the dev-mode OOM.
    ['collection', 'merge', 'uuid', 'cache', 'archiver'].forEach(function(p) {
        assert.match(
            SRC,
            new RegExp("[^_]require\\('\\.\\/" + p + "'\\)"),
            "'" + p + "' must use plain require('./" + p + "') — #B32-residual"
        );
        assert.doesNotMatch(
            SRC,
            new RegExp("_require\\('\\.\\/" + p + "'\\)"),
            "'" + p + "' must NOT use _require('./" + p + "') (reintroduces the #B32-residual leak)"
        );
    });
});

test('§05 replica: a gen-0 parent held OFF require.cache leaks despite the prune; a resident child stays bounded', function() {
    var dir        = os.tmpdir();
    var childFile  = path.join(dir, 'gina-b32r-child-'  + process.pid + '.js');
    var parentFile = path.join(dir, 'gina-b32r-parent-' + process.pid + '.js');
    fs.writeFileSync(childFile, 'module.exports = { v: 1 };');
    // The parent's exported fn requires the child on every call — the
    // `server.isaac.js:853 new Collection()` (gen-0 binding) shape.
    fs.writeFileSync(parentFile,
        'var c = ' + JSON.stringify(childFile) + ';\n' +
        'module.exports = { use: function () { return require(c); } };');
    var childResolved  = require.resolve(childFile);
    var parentResolved = require.resolve(parentFile);

    function prune() {
        var ids = Object.keys(require.cache);
        for (var i = 0; i < ids.length; i++) {
            var cm = require.cache[ids[i]];
            if (cm && cm.children && cm.children.length > 0) {
                cm.children = cm.children.filter(function (ch) { return require.cache[ch.id] === ch; });
            }
        }
    }

    try {
        // ---- LEAK arm: child _require'd (evicted every request); gen-0 parent held OFF require.cache ----
        require(parentFile);
        var parentMod0 = require.cache[parentResolved];   // gen-0 parent Module — we retain this ref
        var p0use      = parentMod0.exports.use;           // its per-request fn
        delete require.cache[parentResolved];              // parent evicted → retained ONLY via parentMod0 (the gen-0 const binding)
        var startLeak = parentMod0.children.length;
        for (var r = 0; r < 25; r++) {
            delete require.cache[childResolved]; require(childFile); // refreshCore rebuilds the child (fresh Module in cache)
            p0use();                                                 // gen-0 parent requires child → fresh Module pushed onto parentMod0.children
            prune();                                                 // require.cache-scoped: parentMod0 is NOT a cache key → never visited
        }
        assert.ok(require.cache[parentResolved] !== parentMod0,
            'gen-0 parent must be off require.cache (retained only by our ref)');
        assert.strictEqual(parentMod0.children.length, startLeak + 25,
            'LEAK: a gen-0 parent off require.cache grows +1 dead child/request despite the prune');

        // ---- FIXED arm: child plain-require'd (never evicted) → cache-hit → Node dedupes → bounded ----
        delete require.cache[parentResolved];
        require(parentFile);
        var parentMod0b = require.cache[parentResolved];
        var p0useB      = parentMod0b.exports.use;
        delete require.cache[parentResolved];
        require(childFile);                                // child resident once and never evicted again (the fix)
        var startFixed = parentMod0b.children.length;
        for (var r2 = 0; r2 < 25; r2++) {
            p0useB();                                      // gen-0 parent requires child → cache-hit on the SAME Module → deduped
            prune();
        }
        assert.ok(parentMod0b.children.length <= startFixed + 1,
            'FIXED: plain-require (resident child) keeps the gen-0 parent children bounded');
    } finally {
        delete require.cache[childResolved];
        delete require.cache[parentResolved];
        try { fs.unlinkSync(childFile); } catch (e) { /* best effort */ }
        try { fs.unlinkSync(parentFile); } catch (e) { /* best effort */ }
        module.children = module.children.filter(function(c) {
            return c.id !== childResolved && c.id !== parentResolved;
        });
    }
});

test('§06 lib/inherits: zero require() in code — the gen-0-captured + per-request-invoked HOT lib must never push a child (#B32-residual completeness audit, 2026-06-16)', function() {
    // Completeness-audit invariant: among the HOT (_require'd) libs, `inherits` is the
    // only one that load-once modules gen-0-capture AND invoke PER REQUEST
    // (router.js:594/595/597/664/890 `const inherits = lib.inherits`; couchbase
    // index.js:718). Because lib/inherits/src/main.js is a pure Object.create
    // prototype-chain builder with ZERO require() calls, each per-request inherits()
    // pushes NO child Module onto its gen-0 (evicted-but-retained) module — so those
    // sites cannot reopen the residual. Measured: +0 children over 200 reqs on the real
    // module vs a +200 leaking control (the routing per-request methods are likewise
    // safe — they carry no in-method require at all since the radix trie was removed).
    // If a require() is EVER added to inherits, this pin trips: re-check whether the
    // target is a HOT (_require'd) lib before updating the pin — a HOT-sibling require
    // would reintroduce #B32-residual for the router/couchbase per-request sites.
    var INHERITS_PATH = path.join(BASE, 'framework', FRAMEWORK_DIR, 'lib', 'inherits', 'src', 'main.js');
    var SRC = fs.readFileSync(INHERITS_PATH, 'utf8');
    // Strip comments first: the module's JSDoc @example contains a literal
    // require(...) string, which a raw scan would match (false positive).
    var code = SRC
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments (incl. JSDoc)
        .replace(/\/\/[^\n]*/g, '');         // line comments
    assert.strictEqual(
        code.indexOf('require('), -1,
        'lib/inherits/src/main.js must contain ZERO require() calls in code (comments stripped) — ' +
        'it is gen-0-captured + invoked per-request by router.js / couchbase; a require() here can reopen #B32-residual'
    );
});
