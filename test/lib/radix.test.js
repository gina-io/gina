var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');

var radix = require(path.join(require('../fw'), 'lib/routing/src/radix'));
var createNode = radix.createNode;
var insert     = radix.insert;
var lookup     = radix.lookup;


// 01 — createNode() shape
describe('01 - createNode(): shape', function() {

    it('returns a plain object', function() {
        assert.equal(typeof createNode(), 'object');
        assert.notEqual(createNode(), null);
    });

    it('has a static property that is an empty object', function() {
        var n = createNode();
        assert.equal(typeof n.static, 'object');
        assert.notEqual(n.static, null);
        assert.equal(Object.keys(n.static).length, 0);
    });

    it('has a param property initially null', function() {
        var n = createNode();
        assert.equal(n.param, null);
    });

    it('has a names property that is an empty array', function() {
        var n = createNode();
        assert.ok(Array.isArray(n.names));
        assert.equal(n.names.length, 0);
    });

    it('two nodes are independent (not shared references)', function() {
        var a = createNode();
        var b = createNode();
        a.names.push('x');
        assert.equal(b.names.length, 0);
    });

});


// 02 — insert(): static routes
describe('02 - insert(): static routes', function() {

    it('single static segment creates a child in root.static', function() {
        var root = createNode();
        insert(root, '/about', 'about@public');
        assert.ok(root.static['about'], 'expected static child "about"');
    });

    it('terminal node receives the route name', function() {
        var root = createNode();
        insert(root, '/about', 'about@public');
        assert.ok(root.static['about'].names.indexOf('about@public') > -1);
    });

    it('two-segment path creates nested static nodes', function() {
        var root = createNode();
        insert(root, '/api/status', 'status@api');
        assert.ok(root.static['api'], 'expected "api" child');
        assert.ok(root.static['api'].static['status'], 'expected "status" grandchild');
        assert.ok(root.static['api'].static['status'].names.indexOf('status@api') > -1);
    });

    it('two routes with shared prefix share the intermediate node', function() {
        var root = createNode();
        insert(root, '/api/users', 'users@api');
        insert(root, '/api/items', 'items@api');
        assert.ok(root.static['api'].static['users']);
        assert.ok(root.static['api'].static['items']);
    });

    it('inserting the same name twice does not duplicate it in names', function() {
        var root = createNode();
        insert(root, '/about', 'about@public');
        insert(root, '/about', 'about@public');
        assert.equal(root.static['about'].names.length, 1);
    });

    it('two different names at the same path are both recorded', function() {
        var root = createNode();
        insert(root, '/about', 'about@public');
        insert(root, '/about', 'about@admin');
        assert.equal(root.static['about'].names.length, 2);
        assert.ok(root.static['about'].names.indexOf('about@public') > -1);
        assert.ok(root.static['about'].names.indexOf('about@admin') > -1);
    });

});


// 03 — insert(): param routes
describe('03 - insert(): param routes', function() {

    it('param segment creates node.param', function() {
        var root = createNode();
        insert(root, '/users/:id', 'getUser@api');
        assert.ok(root.static['users'].param, 'expected param child under "users"');
    });

    it('param terminal node contains the route name', function() {
        var root = createNode();
        insert(root, '/users/:id', 'getUser@api');
        assert.ok(root.static['users'].param.names.indexOf('getUser@api') > -1);
    });

    it('two routes with same param depth share the param node', function() {
        var root = createNode();
        insert(root, '/users/:id', 'getUser@api');
        insert(root, '/users/:uid', 'updateUser@api');
        // both param segments go into the same node.param
        assert.equal(root.static['users'].param.names.length, 2);
    });

    it('deep param route works across multiple levels', function() {
        var root = createNode();
        insert(root, '/api/users/:id/posts', 'userPosts@api');
        assert.ok(root.static['api'].static['users'].param.static['posts']);
        assert.ok(root.static['api'].static['users'].param.static['posts'].names.indexOf('userPosts@api') > -1);
    });

    it('root node itself can have param child', function() {
        var root = createNode();
        insert(root, '/:slug', 'page@public');
        assert.ok(root.param, 'expected root.param');
        assert.ok(root.param.names.indexOf('page@public') > -1);
    });

});


// 04 — insert(): edge cases
describe('04 - insert(): edge cases', function() {

    it('strips query string before inserting', function() {
        var root = createNode();
        insert(root, '/search?q=foo', 'search@public');
        assert.ok(root.static['search'], 'expected "search" node (query stripped)');
        assert.ok(!root.static['search?q=foo'], 'query must not appear as a segment');
    });

    it('strips fragment (#) before inserting', function() {
        var root = createNode();
        insert(root, '/about#top', 'about@public');
        assert.ok(root.static['about'], 'expected "about" node (fragment stripped)');
        assert.ok(!root.static['about#top'], 'fragment must not appear as a segment');
    });

    it('leading slash is silently ignored (empty segment skipped)', function() {
        var root = createNode();
        insert(root, '/home', 'home@public');
        assert.ok(root.static['home'], '"home" must be a direct child of root');
        assert.ok(!root.static[''], 'empty segment from leading slash must not appear');
    });

    it('double slashes are handled without creating empty segments', function() {
        var root = createNode();
        insert(root, '//api//v1', 'v1@api');
        assert.ok(root.static['api']);
        assert.ok(root.static['api'].static['v1']);
    });

    it('root path "/" terminates at the root node', function() {
        var root = createNode();
        insert(root, '/', 'home@public');
        assert.ok(root.names.indexOf('home@public') > -1, 'root "/" should terminate at root node');
    });

});


// 05 — lookup(): static matches
describe('05 - lookup(): static matches', function() {

    function buildRoot() {
        var root = createNode();
        insert(root, '/', 'home@public');
        insert(root, '/about', 'about@public');
        insert(root, '/api/status', 'status@api');
        insert(root, '/api/users', 'users@api');
        return root;
    }

    it('matches root path "/"', function() {
        var root = buildRoot();
        var hits = lookup(root, '/');
        assert.ok(hits.indexOf('home@public') > -1);
    });

    it('matches single-segment path', function() {
        var root = buildRoot();
        var hits = lookup(root, '/about');
        assert.ok(hits.indexOf('about@public') > -1);
    });

    it('matches two-segment path', function() {
        var root = buildRoot();
        var hits = lookup(root, '/api/status');
        assert.ok(hits.indexOf('status@api') > -1);
    });

    it('does not match a sibling route', function() {
        var root = buildRoot();
        var hits = lookup(root, '/api/users');
        assert.equal(hits.indexOf('status@api'), -1);
    });

    it('does not match a non-existent path', function() {
        var root = buildRoot();
        var hits = lookup(root, '/nonexistent');
        assert.equal(hits.length, 0);
    });

    it('returns an array', function() {
        var root = buildRoot();
        assert.ok(Array.isArray(lookup(root, '/about')));
    });

});


// 06 — lookup(): param matches
describe('06 - lookup(): param matches', function() {

    function buildRoot() {
        var root = createNode();
        insert(root, '/users/:id', 'getUser@api');
        insert(root, '/api/users/:id/posts', 'userPosts@api');
        insert(root, '/:slug', 'page@public');
        return root;
    }

    it('matches param segment with any value', function() {
        var root = buildRoot();
        var hits = lookup(root, '/users/42');
        assert.ok(hits.indexOf('getUser@api') > -1);
    });

    it('matches param segment with string value', function() {
        var root = buildRoot();
        var hits = lookup(root, '/users/john');
        assert.ok(hits.indexOf('getUser@api') > -1);
    });

    it('matches deep param route', function() {
        var root = buildRoot();
        var hits = lookup(root, '/api/users/99/posts');
        assert.ok(hits.indexOf('userPosts@api') > -1);
    });

    it('root param matches any top-level segment', function() {
        var root = buildRoot();
        var hits = lookup(root, '/my-page');
        assert.ok(hits.indexOf('page@public') > -1);
    });

    it('param does not match deeper paths when route is shallower', function() {
        var root = buildRoot();
        var hits = lookup(root, '/users/42/extra');
        assert.equal(hits.indexOf('getUser@api'), -1);
    });

});


// 07 — lookup(): static takes priority, but param also returned
describe('07 - lookup(): static and param both returned when they overlap', function() {

    it('static child route is returned for exact static match', function() {
        var root = createNode();
        insert(root, '/users/list', 'userList@api');
        insert(root, '/users/:id', 'getUser@api');
        var hits = lookup(root, '/users/list');
        assert.ok(hits.indexOf('userList@api') > -1, 'static route must be in candidates');
    });

    it('param route is also returned for the same path (candidate set)', function() {
        var root = createNode();
        insert(root, '/users/list', 'userList@api');
        insert(root, '/users/:id', 'getUser@api');
        var hits = lookup(root, '/users/list');
        assert.ok(hits.indexOf('getUser@api') > -1, 'param route must also be in candidates');
    });

    it('static result appears before param result in the output array', function() {
        var root = createNode();
        insert(root, '/users/list', 'userList@api');
        insert(root, '/users/:id', 'getUser@api');
        var hits = lookup(root, '/users/list');
        var si = hits.indexOf('userList@api');
        var pi = hits.indexOf('getUser@api');
        assert.ok(si < pi, 'static candidate should precede param candidate');
    });

    it('param-only path does not include unrelated static route', function() {
        var root = createNode();
        insert(root, '/users/list', 'userList@api');
        insert(root, '/users/:id', 'getUser@api');
        var hits = lookup(root, '/users/42');
        assert.equal(hits.indexOf('userList@api'), -1, 'static "list" must not match numeric segment');
        assert.ok(hits.indexOf('getUser@api') > -1);
    });

});


// 08 — lookup(): no-match cases
describe('08 - lookup(): no-match cases', function() {

    function buildRoot() {
        var root = createNode();
        insert(root, '/api/users', 'users@api');
        insert(root, '/api/users/:id', 'getUser@api');
        return root;
    }

    it('returns empty array for completely unknown path', function() {
        var root = buildRoot();
        assert.equal(lookup(root, '/nope').length, 0);
    });

    it('returns empty array for path that is too deep', function() {
        var root = buildRoot();
        // /api/users has no children named "extra"
        assert.equal(lookup(root, '/api/users/42/extra').length, 0);
    });

    it('returns empty array for empty string input', function() {
        var root = buildRoot();
        // empty string → single empty segment → skipped → depth=segs.length
        // but root.names is empty → empty result
        assert.equal(lookup(root, '').length, 0);
    });

    it('returns empty array for partial prefix only', function() {
        var root = buildRoot();
        // "/api" exists as a node but has no names — only /api/users does
        var hits = lookup(root, '/api');
        assert.equal(hits.indexOf('users@api'), -1);
        assert.equal(hits.indexOf('getUser@api'), -1);
    });

});


// 09 — lookup(): edge cases (query string, trailing slash, double slash)
describe('09 - lookup(): edge cases', function() {

    it('strips query string before matching', function() {
        var root = createNode();
        insert(root, '/search', 'search@public');
        var hits = lookup(root, '/search?q=foo&page=1');
        assert.ok(hits.indexOf('search@public') > -1, 'query string must be stripped');
    });

    it('trailing slash is treated same as no trailing slash', function() {
        var root = createNode();
        insert(root, '/about', 'about@public');
        // "/about/" splits to ['', 'about', ''] — trailing empty seg skipped
        var hits = lookup(root, '/about/');
        assert.ok(hits.indexOf('about@public') > -1, 'trailing slash must not prevent match');
    });

    it('double slashes in lookup path are skipped', function() {
        var root = createNode();
        insert(root, '/api/v1', 'v1@api');
        var hits = lookup(root, '//api//v1');
        assert.ok(hits.indexOf('v1@api') > -1, 'double slashes in lookup must be collapsed');
    });

    it('root "/" path matches after stripping leading slash', function() {
        var root = createNode();
        insert(root, '/', 'home@public');
        var hits = lookup(root, '/');
        assert.ok(hits.indexOf('home@public') > -1);
    });

});


// 10 — buildTrie integration: multiple bundles, URL arrays
describe('10 - multi-bundle isolation', function() {

    it('routes from different bundles do not cross-contaminate', function() {
        var rootA = createNode();
        var rootB = createNode();
        insert(rootA, '/dashboard', 'dashboard@admin');
        insert(rootB, '/home', 'home@public');

        var hitsA = lookup(rootA, '/home');
        assert.equal(hitsA.indexOf('home@public'), -1, 'bundle A should not contain bundle B routes');

        var hitsB = lookup(rootB, '/dashboard');
        assert.equal(hitsB.indexOf('dashboard@admin'), -1, 'bundle B should not contain bundle A routes');
    });

    it('same path in two bundles resolves independently per trie', function() {
        var rootA = createNode();
        var rootB = createNode();
        insert(rootA, '/api/data', 'data@api');
        insert(rootB, '/api/data', 'data@public');

        assert.ok(lookup(rootA, '/api/data').indexOf('data@api') > -1);
        assert.equal(lookup(rootA, '/api/data').indexOf('data@public'), -1);

        assert.ok(lookup(rootB, '/api/data').indexOf('data@public') > -1);
        assert.equal(lookup(rootB, '/api/data').indexOf('data@api'), -1);
    });

});
