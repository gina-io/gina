var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

// Loading helpers triggers PrototypesHelper which adds all prototype extensions
var helpers = require(path.join(require('../fw'), 'helpers'));


// 01 — JSON.clone (heavily used in real projects)
describe('01 - JSON.clone', function () {

    it('deep clones a plain object', function () {
        var original = { name: 'Alice', address: { city: 'Paris' } };
        var clone = JSON.clone(original);
        assert.deepStrictEqual(clone, original);
        assert.notEqual(clone, original);
        assert.notEqual(clone.address, original.address);
    });

    it('does not share nested references', function () {
        var original = { items: [1, 2, 3], meta: { count: 3 } };
        var clone = JSON.clone(original);
        clone.items.push(4);
        clone.meta.count = 4;
        assert.equal(original.items.length, 3);
        assert.equal(original.meta.count, 3);
    });

    it('handles null and primitives', function () {
        assert.equal(JSON.clone(null), null);
        assert.equal(JSON.clone(42), 42);
        assert.equal(JSON.clone('hello'), 'hello');
        assert.equal(JSON.clone(true), true);
    });

    it('handles arrays of objects', function () {
        var original = [{ id: 1 }, { id: 2 }];
        var clone = JSON.clone(original);
        assert.deepStrictEqual(clone, original);
        assert.notEqual(clone, original);
        assert.notEqual(clone[0], original[0]);
    });

    it('handles empty object and array', function () {
        assert.deepStrictEqual(JSON.clone({}), {});
        assert.deepStrictEqual(JSON.clone([]), []);
    });

    it('converts undefined properties to null', function () {
        var original = { a: 1, b: undefined };
        var clone = JSON.clone(original);
        assert.equal(clone.a, 1);
        assert.equal(clone.b, null);
    });

    it('clones request data pattern (real-world)', function () {
        var reqPut = { client: { name: 'Acme', vat: '12345' } };
        var obj = JSON.clone(reqPut);
        obj.client.name = 'Changed';
        assert.equal(reqPut.client.name, 'Acme');
    });

    it('clones session data pattern (real-world)', function () {
        var session = { user: { id: 1, company: { name: 'Corp' } } };
        var userSession = JSON.clone(session.user);
        userSession.company.name = 'Modified';
        assert.equal(session.user.company.name, 'Corp');
    });
});


// 02 — Array.prototype.clone
describe('02 - Array.prototype.clone', function () {

    it('returns a shallow copy', function () {
        var arr = [1, 2, 3];
        var clone = arr.clone();
        assert.deepStrictEqual(clone, arr);
        assert.notEqual(clone, arr);
    });

    it('modifying clone does not affect original', function () {
        var arr = [1, 2, 3];
        var clone = arr.clone();
        clone.push(4);
        assert.equal(arr.length, 3);
    });

    it('is not enumerable', function () {
        var arr = [1, 2];
        var keys = Object.keys(arr);
        assert.equal(keys.indexOf('clone'), -1);
    });
});


// 03 — Array.prototype.inArray
describe('03 - Array.prototype.inArray', function () {

    it('returns true for existing element', function () {
        assert.equal([1, 2, 3].inArray(2), true);
    });

    it('returns false for missing element', function () {
        assert.equal([1, 2, 3].inArray(5), false);
    });

    it('works with strings', function () {
        assert.equal(['a', 'b', 'c'].inArray('b'), true);
        assert.equal(['a', 'b', 'c'].inArray('z'), false);
    });
});


// 04 — JSON.escape
describe('04 - JSON.escape', function () {

    it('escapes newlines', function () {
        assert.equal(JSON.escape('line1\nline2'), 'line1\\nline2');
    });

    it('escapes carriage returns', function () {
        assert.equal(JSON.escape('line1\rline2'), 'line1\\rline2');
    });

    it('escapes tabs', function () {
        assert.equal(JSON.escape('col1\tcol2'), 'col1\\tcol2');
    });

    it('escapes multiple special characters', function () {
        assert.equal(JSON.escape('a\nb\rc\td'), 'a\\nb\\rc\\td');
    });
});


// 05 — Object.prototype.count
describe('05 - Object.prototype.count', function () {

    it('counts own properties', function () {
        assert.equal({ a: 1, b: 2, c: 3 }.count(), 3);
    });

    it('returns 0 for empty object', function () {
        assert.equal({}.count(), 0);
    });

    it('excludes inherited properties', function () {
        var obj = Object.create({ inherited: true });
        obj.own = 1;
        assert.equal(obj.count(), 1);
    });
});


// 06 — Date.prototype extensions (delegated to dateFormat via PrototypesHelper)
describe('06 - Date.prototype extensions', function () {

    var refDate = new Date(2024, 6, 15, 14, 30, 45);

    it('format method exists on Date.prototype', function () {
        assert.equal(typeof refDate.format, 'function');
    });

    it('date.format("isoDate")', function () {
        assert.equal(refDate.format('isoDate'), '2024-07-15');
    });

    it('date.format("isoDateTime")', function () {
        assert.equal(refDate.format('isoDateTime'), '2024-07-15T14:30:45');
    });

    it('new Date().format("isoDateTime") — most common real-world pattern', function () {
        var result = new Date().format('isoDateTime');
        assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    });

    it('date.addDays(n) returns a new Date', function () {
        var result = refDate.addDays(10);
        assert.equal(result.getDate(), 25);
        assert.notEqual(result, refDate);
    });

    it('date.addHours(n) returns a new Date', function () {
        var result = refDate.addHours(2);
        assert.equal(result.getHours(), 16);
    });

    it('date.addDays(n).format(mask) — Swig filter chain', function () {
        var date = new Date(2024, 0, 1);
        var result = date.addDays(30).format('isoDateTime');
        assert.ok(result.startsWith('2024-01-31'));
    });

    it('date.setCulture(code).format(mask) — localized chain', function () {
        var date = new Date(2024, 6, 15, 14, 30, 45);
        var result = date.setCulture('fr').format('fullDate');
        assert.equal(result, 'lundi, 15 Juillet, 2024');
    });
});
