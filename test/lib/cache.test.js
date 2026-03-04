var { describe, it, beforeEach } = require('node:test');
var assert = require('node:assert/strict');

var helpers = require('../../framework/v0.1.6-alpha.177/helpers');
var Cache = require('../../framework/v0.1.6-alpha.177/lib/cache/src/main');


// 01 — basic operations
describe('01 - basic operations', function () {

    var cache;

    beforeEach(function () {
        cache = new Cache();
        cache.from(new Map());
    });

    it('set and get a string value', function () {
        cache.set('key1', 'hello');
        assert.equal(cache.get('key1'), 'hello');
    });

    it('set and get an object value with createdAt', function () {
        cache.set('key1', { name: 'test' });
        var result = cache.get('key1');
        assert.equal(result.name, 'test');
        assert.ok(result.createdAt instanceof Date);
    });

    it('has returns true for existing key', function () {
        cache.set('key1', 'value');
        assert.equal(cache.has('key1'), true);
    });

    it('has returns false for non-existing key', function () {
        assert.equal(cache.has('missing'), false);
    });

    it('get returns undefined for non-existing key', function () {
        assert.equal(cache.get('missing'), undefined);
    });

    it('delete returns true for existing key', function () {
        cache.set('key1', 'value');
        assert.equal(cache.delete('key1'), true);
        assert.equal(cache.has('key1'), false);
    });

    it('delete returns false for non-existing key', function () {
        assert.equal(cache.delete('missing'), false);
    });

    it('size returns correct count', function () {
        assert.equal(cache.size(), 0);
        cache.set('a', 'v1');
        cache.set('b', 'v2');
        assert.equal(cache.size(), 2);
    });

    it('clear removes all entries', function () {
        cache.set('a', 'v1');
        cache.set('b', 'v2');
        cache.clear();
        assert.equal(cache.size(), 0);
        assert.equal(cache.has('a'), false);
        assert.equal(cache.has('b'), false);
    });

    it('set overwrites existing value', function () {
        cache.set('key1', 'first');
        cache.set('key1', 'second');
        assert.equal(cache.get('key1'), 'second');
        assert.equal(cache.size(), 1);
    });
});


// 02 — TTL auto-expiry
describe('02 - TTL auto-expiry', function () {

    it('entry expires after TTL', function (t) {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        var cache = new Cache();
        cache.from(new Map());

        cache.set('temp', { data: 'will expire', ttl: 5 });
        assert.equal(cache.has('temp'), true);

        t.mock.timers.tick(5000);
        assert.equal(cache.has('temp'), false);
        assert.equal(cache.get('temp'), undefined);
    });

    it('entry persists before TTL expires', function (t) {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        var cache = new Cache();
        cache.from(new Map());

        cache.set('temp', { data: 'still here', ttl: 10 });

        t.mock.timers.tick(9000);
        assert.equal(cache.has('temp'), true);
        assert.equal(cache.get('temp').data, 'still here');
    });

    it('TTL converts seconds to milliseconds (boundary)', function (t) {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        var cache = new Cache();
        cache.from(new Map());

        cache.set('temp', { data: 'x', ttl: 3 });

        t.mock.timers.tick(2999);
        assert.equal(cache.has('temp'), true);

        t.mock.timers.tick(1);
        assert.equal(cache.has('temp'), false);
    });

    it('delete clears TTL timeout', function (t) {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        var cache = new Cache();
        cache.from(new Map());

        cache.set('temp', { data: 'x', ttl: 5 });
        cache.delete('temp');

        // Tick past TTL — should not throw (timeout was cleared)
        t.mock.timers.tick(6000);
        assert.equal(cache.has('temp'), false);
    });
});


// 03 — cleanup functions
describe('03 - cleanup functions', function () {

    var cache;

    beforeEach(function () {
        cache = new Cache();
        cache.from(new Map());
    });

    it('cleanup called on delete', function () {
        var called = false;
        cache.set('key1', 'value', function () { called = true; });
        cache.delete('key1');
        assert.equal(called, true);
    });

    it('cleanup called on replace (set existing key)', function () {
        var firstCleaned = false;
        cache.set('key1', 'first', function () { firstCleaned = true; });
        cache.set('key1', 'second');
        assert.equal(firstCleaned, true);
    });

    it('cleanup called for each entry on clear', function () {
        var count = 0;
        cache.set('a', 'v1', function () { count++; });
        cache.set('b', 'v2', function () { count++; });
        cache.clear();
        assert.equal(count, 2);
    });

    it('no error when cleanup is null', function () {
        cache.set('key1', 'value');
        assert.doesNotThrow(function () {
            cache.delete('key1');
        });
    });

    it('TTL expiry bypasses cleanup (uses Map.delete internally)', function (t) {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        var called = false;
        cache.set('temp', { data: 'x', ttl: 1 }, function () { called = true; });

        t.mock.timers.tick(1000);
        assert.equal(cache.has('temp'), false);
        assert.equal(called, false);
    });
});


// 04 — from (shared Map)
describe('04 - from (shared Map)', function () {

    it('operates on the provided Map', function () {
        var sharedMap = new Map();
        var cache = new Cache();
        cache.from(sharedMap);

        cache.set('shared', 'data');
        assert.equal(sharedMap.has('shared'), true);
    });

    it('two instances share state via same Map', function () {
        var sharedMap = new Map();
        var cache1 = new Cache();
        var cache2 = new Cache();
        cache1.from(sharedMap);
        cache2.from(sharedMap);

        cache1.set('key', 'from-c1');
        assert.equal(cache2.get('key'), 'from-c1');
    });
});


// 05 — event invalidation
describe('05 - event invalidation', function () {

    var cache;

    beforeEach(function () {
        cache = new Cache();
        cache.from(new Map());
    });

    it('setEvents registers events for a cache key', function () {
        cache.set('user:123', { name: 'Alice' });
        cache.setEvents('user:123', ['user:updated', 'user:deleted']);

        assert.equal(cache._events.length, 2);
    });

    it('invalidateByEvent deletes the cache entry', function () {
        cache.set('user:123', { name: 'Alice' });
        cache.setEvents('user:123', ['user:updated']);

        cache.invalidateByEvent('user:updated');
        assert.equal(cache.has('user:123'), false);
    });

    it('invalidateByEvent removes the event registration', function () {
        cache.set('user:123', { name: 'Alice' });
        cache.setEvents('user:123', ['user:updated']);

        cache.invalidateByEvent('user:updated');

        // Second invalidation should be a no-op (no error)
        cache.invalidateByEvent('user:updated');
    });

    it('multiple events for same key — first event evicts', function () {
        cache.set('user:123', { name: 'Alice' });
        cache.setEvents('user:123', ['user:updated', 'user:deleted']);

        cache.invalidateByEvent('user:updated');
        assert.equal(cache.has('user:123'), false);

        // Key already gone — second event is harmless
        cache.invalidateByEvent('user:deleted');
    });

    it('multiple keys for same event — all evicted', function () {
        cache.set('user:1', { name: 'Alice' });
        cache.set('user:2', { name: 'Bob' });
        cache.setEvents('user:1', ['users:changed']);
        cache.setEvents('user:2', ['users:changed']);

        cache.invalidateByEvent('users:changed');
        assert.equal(cache.has('user:1'), false);
        assert.equal(cache.has('user:2'), false);
    });

    it('invalidateByEvent calls cleanup on evicted entries', function () {
        var cleaned = false;
        cache.set('user:123', { name: 'Alice' }, function () { cleaned = true; });
        cache.setEvents('user:123', ['user:updated']);

        cache.invalidateByEvent('user:updated');
        assert.equal(cleaned, true);
    });

    it('repeated setEvents creates duplicate registrations', function () {
        cache.set('key', { v: 1 });
        cache.setEvents('key', ['evt']);
        cache.setEvents('key', ['evt']);

        // Known quirk: findOne dedup check inside setEvents does not
        // prevent duplicates — two entries are inserted.
        assert.equal(cache._events.length, 2);
    });
});
