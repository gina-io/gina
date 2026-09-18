'use strict';
/**
 * #B559 — a request parameter must not steer control flow in redirect().
 *
 * `SuperController::redirect()` carried a gate that tested the incoming
 * client-populated params for a key named `error` and, when present, called
 * throwError() with that raw value and returned instead of redirecting.
 * `req[method]` is client-populated (server.js assigns `request.get =
 * request.query`, and `request.post` from the parsed body), so any
 * unauthenticated request to any route whose action redirects could force a
 * 500 -- and an EMPTY value left the request UNANSWERED, because the empty
 * string is falsy and throwError()'s #B44 late-call guard mistook it for a
 * call on an already-released response.
 *
 * Driven live on a booted bundle before and after the fix (isaac, http/2,
 * dev), each arm against a control that had to keep its pre-fix value:
 *
 *   GET  /:slug                      302 -> 302   (control, unchanged)
 *   GET  /:slug?error=BOOM           500 -> 302   (value no longer reflected)
 *   GET  /:slug?error=               HANG -> 302
 *   POST /login  (bad creds)         303 -> 303   (control, unchanged)
 *   POST /login  body error=X        500 -> 303
 *   POST /login  body error=         HANG -> 303
 *
 * The pins below are the committed regression guard for that drive.
 *
 * Red-first seam: set GINA_B559_SRC to a frozen pre-fix copy of
 * controller.js and every pin in §01/§02 must FAIL. Validated that way --
 * see the arc record.
 *
 * Usage: node --test test/core/redirect-error-param-b559.test.js
 */

var test   = require('node:test');
var describe = test.describe;
var it       = test.it;
var assert = require('assert');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SOURCE = process.env.GINA_B559_SRC || path.join(FW, 'core/controller/controller.js');
var RAW    = fs.readFileSync(SOURCE, 'utf8');

/**
 * Strips `//` line comments so a negative pin cannot be satisfied by the
 * fix's own explanatory comment, which necessarily names the defect it
 * replaced. Leaves string literals containing `://` alone.
 *
 * @inner
 * @param {string} src - raw file text
 * @returns {string} src with line comments removed
 */
function stripLineComments(src) {
    return src.split('\n').map(function (l) {
        var i = l.indexOf('//');
        if (i < 0) { return l; }
        if (i > 0 && l.charAt(i - 1) === ':') { return l; }   // scheme://
        return l.slice(0, i);
    }).join('\n');
}

var CODE = stripLineComments(RAW);

/**
 * The redirect() body, from its declaration to the inheritedData size cap.
 *
 * @inner
 * @param {string} src - source to slice
 * @returns {string} the region
 */
function redirectRegion(src) {
    var s = src.indexOf('this.redirect = async function');
    assert.ok(s > -1, 'redirect() declaration not found');
    var e = src.indexOf('reached 2000 chars limit', s);
    assert.ok(e > s, 'inheritedData cap not found after redirect()');
    return src.slice(s, e);
}

describe('01 - the error-param gate is gone from redirect() (#B559)', function () {

    it('the comment stripper actually removed something (anti-vacuous control)', function () {
        // Without this, a stripper that returned '' would satisfy every
        // negative pin below for the wrong reason.
        assert.ok(CODE.length < RAW.length, 'stripper removed nothing');
        assert.ok(CODE.length > RAW.length * 0.5, 'stripper removed far too much');
        assert.ok(CODE.indexOf('this.redirect = async function') > -1,
            'stripper destroyed the code under test');
    });

    it('no throwError call is reachable from an incoming param key', function () {
        var region = redirectRegion(CODE);
        assert.equal(region.indexOf('redirectError'), -1,
            'the dead redirectError local is back');
        assert.equal(region.indexOf('requestParams.error'), -1,
            'redirect() reads an `error` key off the client-populated params again');
    });

    it('the raw text still documents the removal (so a broken strip cannot pass vacuously)', function () {
        // If stripLineComments ever over-matched and blanked the file, the two
        // pins above would pass trivially. The marker only exists in a comment,
        // so it must be present in RAW and absent from CODE.
        assert.ok(RAW.indexOf('#B559') > -1, 'the #B559 rationale comment is missing');
        assert.equal(stripLineComments(RAW).indexOf('#B559'), -1,
            'the #B559 marker survived stripping - it is not in a comment');
    });
});

describe('02 - incoming params reach the carry-forward path unconditionally (#B559)', function () {

    it('requestParams flows into the inheritedData merge with no early return between', function () {
        var region = redirectRegion(CODE);
        var decl   = region.indexOf('var requestParams = req[req.method.toLowerCase()]');
        var merge  = region.indexOf('requestParams = merge(requestParams, oldParams)');
        assert.ok(decl > -1,  'requestParams declaration not found');
        assert.ok(merge > decl, 'the inheritedData merge no longer follows the declaration');

        // Nothing between the two may bail out of redirect(). The wrong-method
        // block in between reassigns the method; it does not return.
        var between = region.slice(decl, merge);
        assert.equal(between.indexOf('return;'), -1,
            'an early return reappeared between the params read and the carry-forward merge');
        assert.equal(between.indexOf('throwError'), -1,
            'a throwError call reappeared between the params read and the carry-forward merge');
    });
});
