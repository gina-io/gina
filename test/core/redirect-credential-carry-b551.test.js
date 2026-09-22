'use strict';
/**
 * #B551 — credentials must not ride a redirect.
 *
 * `SuperController::redirect()` carries the request's parameter container to the
 * redirect target, either on the session (`inheritedData`) or, on a session-less
 * bundle, in the target URL. For a POST that container is the parsed body
 * verbatim, so a login POST carried the plaintext password.
 *
 * DRIVEN live on a booted bundle (isaac, http/2, dev), session store = sqlite,
 * with a sentinel password and two controls:
 *
 *   before   failed login  -> session row held "password":"<plaintext>"
 *            success login -> password survived the consuming 200 GET at
 *                             user.inheritedData.password
 *            failed login  -> after the consuming GET it had been COPIED ON to
 *                             haltedRequest.data.password
 *   after    password sentinel 0 on BOTH paths
 *            email sentinel 1   (control: the carry itself still works, so the
 *                                fix is selective, not a blanket disable)
 *            never-sent string 0 (control: the query discriminates)
 *
 * Two facts the fix depends on, both measured:
 *   - `lib/merge` does NOT clone (its clone block is commented out), so the
 *     stashed object was a LIVE reference to `req.post`. The fix therefore
 *     builds a COPY; filtering in place would strip fields the application's
 *     own action may still read.
 *   - the filter runs BEFORE both the URL build and both session writes, so the
 *     session-less URL branch is covered by the same pass.
 *
 * Red-first seam: point GINA_B551_SRC at a pre-fix copy of controller.js and
 * every §01 pin must fail.
 *
 * Usage: node --test test/core/redirect-credential-carry-b551.test.js
 */

var test     = require('node:test');
var describe = test.describe;
var it       = test.it;
var assert   = require('assert');
var fs       = require('fs');
var path     = require('path');

var FW     = require('../fw');
var SOURCE = process.env.GINA_B551_SRC || path.join(FW, 'core/controller/controller.js');
var RAW    = fs.readFileSync(SOURCE, 'utf8');

describe('01 - source pins: the carried params are filtered, on a copy (#B551)', function () {

    it('redirect() filters the carried params through the shared redaction matcher', function () {
        assert.ok(RAW.indexOf("require('../../lib/inspector-redact')") > -1,
            'controller.js no longer requires the shared redaction matcher');
        assert.ok(RAW.indexOf('inspectorRedact.keyMatches(') > -1,
            'the carried params are no longer key-matched against the redaction list');
    });

    it('the filter builds a COPY — it must not delete from the live container', function () {
        var build = RAW.indexOf('var _carriedParams = {};');
        assert.ok(build > -1, 'the filtered copy is gone');
        var assign = RAW.indexOf('requestParams = _carriedParams;');
        assert.ok(assign > build, 'the copy is no longer assigned back over requestParams');

        // lib/merge does not clone, so `requestParams` aliases req.post. A
        // `delete requestParams[...]` in this region would mutate the live body.
        var region = RAW.slice(build, assign);
        assert.equal(region.indexOf('delete requestParams'), -1,
            'the filter deletes from the live request container instead of copying');
    });

    it('the filter precedes BOTH externalisation sites (URL branch and session writes)', function () {
        var filter  = RAW.indexOf('requestParams = _carriedParams;');
        var url     = RAW.indexOf("'?inheritedData='");
        var session = RAW.indexOf('userSession.inheritedData = requestParams');
        assert.ok(filter > -1 && url > -1 && session > -1, 'a landmark is missing');
        assert.ok(filter < url,     'the URL branch is built before the filter runs');
        assert.ok(filter < session, 'the session stash happens before the filter runs');
    });

    it('the drop is logged at debug, never warn (a login always carries a password)', function () {
        var i = RAW.indexOf('credential-class field(s) not carried across the redirect');
        assert.ok(i > -1, 'the drop notice is gone');
        var line = RAW.slice(RAW.lastIndexOf('\n', i) + 1, i);
        assert.ok(line.indexOf('console.debug') > -1,
            'the drop notice is not at debug level — at warn it would fire on the success ' +
            'path of every login, which is the #B552 mistake');
    });
});

describe('02 - the key list actually covers credential fields (#B551)', function () {

    var redact   = require(path.join(FW, 'lib/inspector-redact/src/main.js'));
    var compiled = redact.compile(redact.DEFAULT_PATTERNS);

    it('CONTROL: an ordinary field is NOT matched (the matcher discriminates)', function () {
        assert.equal(redact.keyMatches('email', compiled), false);
        assert.equal(redact.keyMatches('slug', compiled), false);
    });

    it('credential-class keys are matched', function () {
        ['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'authorization', 'credentials']
            .forEach(function (k) {
                assert.equal(redact.keyMatches(k, compiled), true, k + ' is no longer matched');
            });
    });

    it('separator and case variants are matched (tokenising, not substring)', function () {
        ['apiKey', 'api_key', 'user_token'].forEach(function (k) {
            assert.equal(redact.keyMatches(k, compiled), true, k + ' is no longer matched');
        });
    });

    it('metadata keys are deliberately NOT matched, so they still travel', function () {
        // A form carrying its own validation rules must keep working.
        ['passwordRules', 'tokenFormat'].forEach(function (k) {
            assert.equal(redact.keyMatches(k, compiled), false, k + ' is now being dropped');
        });
    });

    it('filtering yields a copy and leaves the source object intact', function () {
        var input = { email: 'a@b.c', password: 'SECRET', apiKey: 'k', passwordRules: 'len>8' };
        var out = {}, dropped = [];
        Object.keys(input).forEach(function (k) {
            if (redact.keyMatches(k, compiled)) { dropped.push(k); return; }
            out[k] = input[k];
        });
        assert.deepEqual(Object.keys(out).sort(), ['email', 'passwordRules']);
        assert.deepEqual(dropped.sort(), ['apiKey', 'password']);
        // the source keeps every key — this is what stops the live req.post being stripped
        assert.equal(Object.keys(input).length, 4);
    });
});
