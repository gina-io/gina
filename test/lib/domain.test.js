var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var Domain = require(path.join(require('../fw'), 'lib/domain/src/main'));

var dataDir = path.join(require('../fw'), 'lib/domain/test/data');
var testCases = JSON.parse(fs.readFileSync(path.join(dataDir, 'urls-or-hostnames.json')));


// 01 — getRootDomain
describe('01 - getRootDomain', function () {

    var domainInstance;

    before(function () {
        return new Promise(function (resolve, reject) {
            new Domain(function onReady(err, instance) {
                if (err) return reject(err);
                domainInstance = instance;
                resolve();
            });
        });
    });

    for (var i = 0; i < testCases.length; i++) {
        (function (testCase) {
            it('`' + testCase.request.trim() + '` -> ' + testCase.expected.value, function () {
                var result = domainInstance.getRootDomain(testCase.request, true);
                assert.equal(typeof result, 'object');
                assert.deepStrictEqual(result, testCase.expected);
            });
        })(testCases[i]);
    }
});


// 02 — synchronous instantiation (real-world pattern: new Domain().getRootDomain(host).value)
describe('02 - synchronous instantiation', function () {

    it('getRootDomain works without callback', function () {
        var domain = new Domain();
        var result = domain.getRootDomain('http://www.google.co.uk/blah', true);
        assert.equal(result.value, 'google.co.uk');
        assert.equal(result.isSLD, true);
        assert.equal(result.isRegisteredTldOrSld, true);
    });

    it('.value shorthand (no jsonFormat)', function () {
        var domain = new Domain();
        var result = domain.getRootDomain('https://public-dev.freelancer.app/index.php');
        assert.equal(result.value, 'freelancer.app');
    });

    it('hostname without protocol', function () {
        var domain = new Domain();
        var result = domain.getRootDomain('Mac-mini.local');
        assert.equal(result.value, 'Mac-mini.local');
        assert.equal(result.isRegisteredTldOrSld, false);
    });
});


// 03 — getFQDN
describe('03 - getFQDN', function () {

    var domainInstance;

    before(function () {
        return new Promise(function (resolve, reject) {
            new Domain(function onReady(err, instance) {
                if (err) return reject(err);
                domainInstance = instance;
                resolve();
            });
        });
    });

    it('returns a FQDN string with a dot', async function () {
        var result = await domainInstance.getFQDN();
        assert.equal(typeof result, 'string');
        assert.equal(/\./.test(result), true);
    });
});
