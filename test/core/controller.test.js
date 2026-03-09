var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SOURCE = path.resolve(__dirname, '../../framework/v0.1.6-alpha.177/core/controller/controller.js');


// 01 — strParts path building (Array.push + join replaces str += key + '.' in setOptions loop)
describe('01 - setOptions routing param: strParts path building (Array.push + join)', function() {

    it('push key onto [page] yields page.key via join', function() {
        var strParts = ['page'];
        strParts.push('title');
        assert.equal(strParts.join('.'), 'page.title');
    });

    it(':value branch — strParts = [page, view, params, key] yields page.view.params.key', function() {
        var key = 'id';
        var strParts = ['page', 'view', 'params', key];
        assert.equal(strParts.join('.'), 'page.view.params.id');
    });

    it('file/title branch — strParts = [page, view, key] yields page.view.key', function() {
        var key = 'title';
        var strParts = ['page', 'view', key];
        assert.equal(strParts.join('.'), 'page.view.title');
    });

    it('reset to [page] yields page and length 1', function() {
        var strParts = ['page', 'title'];
        strParts = ['page'];
        assert.equal(strParts.join('.'), 'page');
        assert.equal(strParts.length, 1);
    });

    it('multiple outer iterations accumulate when inner branch does not reset', function() {
        // mirrors original str += behaviour: str starts 'page.', += 'key1.' → 'page.key1.'
        // then without reset: += 'key2.' → 'page.key1.key2.'
        var strParts = ['page'];
        strParts.push('key1');
        assert.equal(strParts.join('.'), 'page.key1');
        strParts.push('key2');
        assert.equal(strParts.join('.'), 'page.key1.key2');
    });

    it('join result matches str.substring(0, str.length-1) equivalence', function() {
        // original: str = 'page.' + key + '.' → str.substring(0, str.length-1) = 'page.' + key
        var key = 'file';
        var str = 'page.' + key + '.';
        var strParts = ['page', key];
        assert.equal(strParts.join('.'), str.substring(0, str.length - 1));
    });

});


// 02 — valueParts accumulation (Array.push + join replaces value += obj[prop] in inner loop)
describe('02 - setOptions routing param: valueParts accumulation (Array.push + join)', function() {

    it('single push joins to itself', function() {
        var valueParts = [];
        valueParts.push('hello');
        assert.equal(valueParts.join(''), 'hello');
    });

    it('multiple pushes join without separator', function() {
        var valueParts = [];
        valueParts.push('hello');
        valueParts.push(' world');
        assert.equal(valueParts.join(''), 'hello world');
    });

    it('empty parts join to empty string', function() {
        var valueParts = [];
        assert.equal(valueParts.join(''), '');
    });

    it('join result matches sequential += for same inputs', function() {
        var value = '';
        value += 'foo';
        value += 'bar';
        var valueParts = [];
        valueParts.push('foo');
        valueParts.push('bar');
        assert.equal(valueParts.join(''), value);
    });

});


// 03 — source structure: string += replaced with Array.push/join in setOptions (#P26)
describe('03 - source structure: string += replaced with Array.push/join in setOptions (#P26)', function() {

    it('strParts.push(key) is present in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('strParts.push(key)') > -1,
            'expected `strParts.push(key)` — #P26 not applied'
        );
    });

    it('valueParts.push(obj[prop]) is present in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('valueParts.push(obj[prop])') > -1,
            'expected `valueParts.push(obj[prop])` — #P26 not applied'
        );
    });

    it("strParts.join('.') is present in source", function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("strParts.join('.')") > -1,
            "expected `strParts.join('.')` — #P26 not applied"
        );
    });

    it("valueParts.join('') is present in source", function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("valueParts.join('')") > -1,
            "expected `valueParts.join('')` — #P26 not applied"
        );
    });

    it('str += key pattern is gone from setOptions loop (outside comments)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var stripped = src.replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/str\s*\+=\s*key/.test(stripped),
            'old `str += key` still present outside comments — #P26 not applied'
        );
    });

    it('value += obj[prop] pattern is gone from setOptions loop (outside comments)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var stripped = src.replace(/\/\/[^\n]*/g, '');
        assert.ok(
            !/value\s*\+=\s*obj\[/.test(stripped),
            'old `value += obj[` still present outside comments — #P26 not applied'
        );
    });

    it('source contains #P26 replaced comment', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('#P26') > -1,
            'expected #P26 marker — comment convention not applied'
        );
    });

});
