/**
 * #B785 — fs restart read-back follows the writer's root. The render delegates write an
 * `fs`-strategy entry under `server.cache.path`; isaac's pre-routing read used to root its
 * disk read-back at `options.cachePath` — the top-level infra `cachePath`, equal to the
 * writer's root only by default — so a bundle with a custom `server.cache.path` wrote its
 * entries where no restarted process looked (measured live: `fwd=uri-miss` after a restart
 * while the default-path control answered `hit; detail=fs`). The value isaac needs was
 * already stamped on the instance as `_cachePath` by core/server.js — behind a guard that
 * tested a misspelt key, so the stamp ran on every call and nothing read it. The offline
 * `cache:clear` reclaim had the same assumption.
 *
 *  §01 — core/server.js: the stamp is guarded on the property it stamps; the misspelt key is gone.
 *  §02 — core/server.isaac.js: the read-back root is `server._cachePath || options.cachePath`
 *        (pinned, then the shipped line is executed against spies: stamped → the stamp,
 *        unstamped / empty → the infra root).
 *  §03 — lib/render-cache: an entry written under a custom root reads back through
 *        `from(store, <that root>)` and NOT through another root (the pre-fix shape, as a control).
 *  §04 — `RenderCache.resolveCacheRoot` (pure): sub-file > settings.json > env.json > default,
 *        token substitution, unknown tokens kept.
 *  §05 — lib/cmd/cache/clear.js reclaims under the resolved root, project default as fallback.
 *
 * Seams: GINA_SERVER_SRC / GINA_ISAAC_SRC / GINA_CACHE_CLEAR_SRC=<file>, GINA_RENDER_CACHE_MAIN=
 * <module path>. Red-first: against the pre-#B785 bytes §01, §02 and §05 pins fail and §04 finds
 * no `resolveCacheRoot`; §03 passes on both (it exercises the lib the fix now reaches).
 *
 * Usage: node --test test/core/server-render-cache-readback-b785.test.js
 */
'use strict';

var fs   = require('fs');
var os   = require('os');
var path = require('path');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');
// Side-effect: installs the `_` PathObject global lib/render-cache's fs strategy uses.
require(path.join(FW, 'helpers'));

var SERVER_SRC  = fs.readFileSync(process.env.GINA_SERVER_SRC      || path.join(FW, 'core/server.js'), 'utf8');
var ISAAC_SRC   = fs.readFileSync(process.env.GINA_ISAAC_SRC       || path.join(FW, 'core/server.isaac.js'), 'utf8');
var CLEAR_SRC   = fs.readFileSync(process.env.GINA_CACHE_CLEAR_SRC || path.join(FW, 'lib/cmd/cache/clear.js'), 'utf8');
var RenderCache = require(process.env.GINA_RENDER_CACHE_MAIN || path.join(FW, 'lib/render-cache/src/main'));

/** Comment-stripped copy for the negative pins (the replace-code convention keeps old lines in comments). */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
}

describe('01 - core/server.js stamps server.cache.path on the instance behind the right guard', function() {
    it('the guard tests the property it stamps, once', function() {
        var m = SERVER_SRC.match(/typeof\(instance\._cachePath\) == 'undefined'/g) || [];
        assert.strictEqual(m.length, 1);
        assert.match(SERVER_SRC, /typeof\(instance\._cachePath\) == 'undefined' \) \{\s*\n\s*instance\._cachePath = self\.conf\[self\.appName\]\[self\.env\]\.server\.cache\.path;/);
    });
    it('the misspelt key is gone from the file (raw text, comments included)', function() {
        assert.strictEqual(SERVER_SRC.indexOf('_cachedPath'), -1);
    });
});

describe('02 - core/server.isaac.js reads the fs entries back from the writer\'s root', function() {
    var LINE = 'renderCache.from(server._cached, server._cachePath || options.cachePath);';
    it('pins the read-back root expression, once', function() {
        assert.strictEqual(ISAAC_SRC.split(LINE).length, 2, 'exactly one occurrence');
        assert.strictEqual(stripComments(ISAAC_SRC).indexOf('renderCache.from(server._cached, options.cachePath)'), -1, 'the infra-root-only form is gone from the code');
    });

    /**
     * Executes the shipped line against a `from()` spy.
     * @param {*} stamp - server._cachePath
     * @returns {string} the root passed to from()
     * @inner
     */
    function root(stamp) {
        var got = null;
        /* eslint-disable no-new-func */
        var fn = new Function('renderCache', 'server', 'options', LINE);
        fn({ from: function(store, r) { got = r; } }, { _cached: new Map(), _cachePath: stamp }, { cachePath: '/infra/cache' });
        return got;
    }
    it('BEHAVIOUR: a stamped custom root is what the read-back uses', function() {
        assert.strictEqual(root('/var/cache/app'), '/var/cache/app');
    });
    it('BEHAVIOUR: an unstamped or empty stamp falls back to the infra root', function() {
        assert.strictEqual(root(undefined), '/infra/cache');
        assert.strictEqual(root(''), '/infra/cache');
    });
});

describe('03 - lib/render-cache: an entry written under a custom root reads back from that root only', function() {
    var tmpRoot;
    before(function() { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b785-')); });
    after(function() { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {} });

    it('write under <custom>, read back through from(store, <custom>) — and not through another root', async function() {
        var custom = path.join(tmpRoot, 'custom'), other = path.join(tmpRoot, 'other');
        fs.mkdirSync(other, { recursive: true });
        var rc  = new RenderCache();
        rc.from(new Map());
        var key = 'static:app:/page';
        await rc.set('fs', key, { visibility: 'private' }, { content: '<h1>p</h1>', path: custom, bundle: 'app', url: '/page', kind: 'html' });
        var file = String(rc.get(key).filename);
        assert.strictEqual(file.indexOf(custom), 0, 'the body lives under the custom root');
        assert.ok(fs.existsSync(file), 'the body file exists');

        // post-restart: an empty Map rooted at the writer's root → read back
        rc.from(new Map(), custom);
        assert.ok(rc.has(key), 'has() sees the disk entry');
        assert.strictEqual(String(rc.get(key).filename), file);

        // the pre-fix shape: an empty Map rooted elsewhere → nothing
        rc.from(new Map(), other);
        assert.strictEqual(rc.get(key), undefined, 'another root cannot see it (the #B785 miss)');
        rc.from(new Map());
    });
});

describe('04 - RenderCache.resolveCacheRoot (pure) — the offline precedence', function() {
    var T = { projectPath: '/srv/proj', bundle: 'app' };
    it('no source → the default `${cachePath}` = <projectPath>/cache', function() {
        assert.strictEqual(RenderCache.resolveCacheRoot({}, T), '/srv/proj/cache');
        assert.strictEqual(RenderCache.resolveCacheRoot(undefined, T), '/srv/proj/cache');
    });
    it('settings.json server.cache.path wins over env.json; the sub-file wins over both', function() {
        var env = { server: { cache: { path: '/env/root' } } };
        var set = { server: { cache: { path: '/set/root' } } };
        var sub = { path: '/sub/root' };
        assert.strictEqual(RenderCache.resolveCacheRoot({ envBlock: env }, T), '/env/root');
        assert.strictEqual(RenderCache.resolveCacheRoot({ envBlock: env, settings: set }, T), '/set/root');
        assert.strictEqual(RenderCache.resolveCacheRoot({ envBlock: env, settings: set, subFile: sub }, T), '/sub/root');
    });
    it('an empty or non-string path falls through to the next source', function() {
        assert.strictEqual(RenderCache.resolveCacheRoot({ subFile: { path: '' }, settings: { server: { cache: { path: 7 } } }, envBlock: { server: { cache: { path: '/env/root' } } } }, T), '/env/root');
    });
    it('substitutes ${cachePath}, ${projectPath}, ${executionPath} and ${bundle}; keeps unknown tokens', function() {
        assert.strictEqual(RenderCache.resolveCacheRoot({ settings: { server: { cache: { path: '${cachePath}' } } } }, T), '/srv/proj/cache');
        assert.strictEqual(RenderCache.resolveCacheRoot({ settings: { server: { cache: { path: '${projectPath}/tmp/${bundle}' } } } }, T), '/srv/proj/tmp/app');
        assert.strictEqual(RenderCache.resolveCacheRoot({ settings: { server: { cache: { path: '${executionPath}/c' } } } }, T), '/srv/proj/c');
        assert.strictEqual(RenderCache.resolveCacheRoot({ settings: { server: { cache: { path: '${elsewhere}/c' } } } }, T), '${elsewhere}/c');
    });
    it('env.json may redefine the ${cachePath} token itself', function() {
        var env = { cachePath: '${projectPath}/var/cache' };
        assert.strictEqual(RenderCache.resolveCacheRoot({ envBlock: env }, T), '/srv/proj/var/cache');
        assert.strictEqual(RenderCache.resolveCacheRoot({ envBlock: env, settings: { server: { cache: { path: '${cachePath}/x' } } } }, T), '/srv/proj/var/cache/x');
    });
});

describe('05 - lib/cmd/cache/clear.js reclaims under the resolved root', function() {
    it('the offline reclaim passes the bundle\'s resolved root, with the project default as fallback', function() {
        assert.match(CLEAR_SRC, /clearFsBundle\(resolveBundleRoot\(bundle\), bundle, \{ dryRun: self\.dryRun \}\)/);
        assert.match(CLEAR_SRC, /RenderCache\.resolveCacheRoot\(\{/);
        assert.match(CLEAR_SRC, /settings\.server\.cache\.' \+ env \+ '\.json/);
        assert.match(CLEAR_SRC, /\? root : self\.projectCachePath;/, 'the unresolved fallback');
        assert.match(CLEAR_SRC, /catch \(e\) \{\s*\n\s*return self\.projectCachePath;/, 'the thrown fallback');
    });
});
