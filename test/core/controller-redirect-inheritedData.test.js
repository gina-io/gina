var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SOURCE = path.join(require('../fw'), 'core/controller/controller.js');
var SRC = fs.readFileSync(SOURCE, 'utf8');

// Object.prototype.count() — the same injected prototype the framework relies on
// (requestParams.count() / data.count() inside the extracted blocks below).
require(path.join(__dirname, '../../utils/prototypes'));

// Conservative comment strip for the whole-file NEGATIVE pins: removes block
// comments and full-line `//` comments only (an inline `//` after code — e.g. a
// URL literal — is left alone), so a negative can never be satisfied vacuously
// by a comment mention nor tripped by one.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(function (l) { return !/^\s*\/\//.test(l); })
        .join('\n');
}
var CODE = stripComments(SRC);

// End-anchored body slices (insertion-safe — the §34/§35 precedent).
function sliceBetween(src, startTok, endTok) {
    var s = src.indexOf(startTok);
    assert.ok(s > -1, 'slice start anchor missing: ' + startTok);
    var e = src.indexOf(endTok, s);
    assert.ok(e > s, 'slice end anchor missing: ' + endTok);
    return src.substring(s, e);
}

// Brace-matched extraction of a block starting at `startToken` — the extracted
// text is the REAL shipped source, executed below via new Function (no replica
// to drift). The extraction itself is control-gated: exactly one occurrence,
// balance reached, expected content present, boundary content absent.
/**
 * The shipped `ownCount` helper (#B546), lifted from controller.js and made callable.
 * The blocks extracted below now count through it, so they are driven with the real
 * helper rather than a replica.
 * @param {string} src
 * @returns {function(*): number}
 * @inner
 */
function ownCountFrom(src) {
    var at = src.indexOf('function ownCount(container) {');
    assert.ok(at > -1, 'controller.js declares the ownCount helper');
    var depth = 0, end = -1;
    for (var j = src.indexOf('{', at); j < src.length; j++) {
        if (src[j] === '{') { depth++; }
        else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    assert.ok(end > at, 'the ownCount helper closes');
    /* eslint-disable no-new-func */
    return new Function(src.slice(at, end + 1) + '; return ownCount;')();
}

function extractBlock(src, startToken) {
    var first = src.indexOf(startToken);
    assert.ok(first > -1, 'extraction start token missing: ' + startToken);
    assert.equal(src.indexOf(startToken, first + 1), -1, 'extraction start token must be unique: ' + startToken);
    var braceStart = src.indexOf('{', first);
    var depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; if (depth === 0) { break; } }
    }
    assert.equal(depth, 0, 'brace matching must close the block');
    return src.substring(first, i + 1);
}


// 01 — source pins. Each validated against its own adversary at development
// time (pre-fix source fails every change-pin; per-pin perturbations fail the
// stays-put pins) — see the slice's harness record. Anchors are structural
// (existence asserted before any ordering compare), never fixed-char windows.
describe('01 - redirect()/resumeRequest() session-default inheritedData carry — source pins', function() {

    var redirectBody = sliceBetween(SRC, 'this.redirect = async function(req, res, next) {', 'Move files to assets dir');
    var resumeBody   = sliceBetween(SRC, 'this.resumeRequest = function(requestStorage) {', 'this.renderCustomError');

    it('the #B75-guarded userSession derivation is hoisted into the count>0 block, before the XHR branch', function() {
        var idxDerive = redirectBody.indexOf("var userSession = ( typeof(req.session) != 'undefined' && req.session )");
        var idxXhr    = redirectBody.indexOf('if ( self.isXMLRequest() ) {');
        assert.ok(idxDerive > -1, 'guarded derivation must exist in the redirect body');
        assert.ok(idxXhr > -1, 'XHR branch anchor must exist');
        assert.ok(idxDerive < idxXhr, 'the derivation must precede the XHR branch (hoisted, single derive)');
    });

    it('the URL build + 2000-char cap are gated on the session-less fallback', function() {
        var idxGate  = redirectBody.indexOf('if ( !userSession ) {');
        var idxBuild = redirectBody.indexOf("inheritedData = '?inheritedData='");
        var idxCap   = redirectBody.indexOf('reached 2000 chars limit');
        assert.ok(idxGate > -1, 'the !userSession fallback gate must exist');
        assert.ok(idxBuild > -1, 'the URL build must still exist (session-less fallback)');
        assert.ok(idxCap > -1, 'the 2000-char cap must still exist (session-less fallback)');
        assert.ok(idxGate < idxBuild && idxBuild < idxCap, 'gate must precede build, build must precede cap');
    });

    it('exactly two gate+stash sites: the XHR branch and the method-switch branch', function() {
        // Composite token (gate adjacent to stash) — unique to the two shipped
        // sites; a bare stash count would also match nothing else, but the
        // composite locks the GATING, not just the write.
        var m = redirectBody.match(/if \( userSession \) \{[\s\S]{0,500}?userSession\.inheritedData = requestParams;/g);
        assert.ok(m, 'gate+stash composite must match');
        assert.equal(m.length, 2, 'XHR branch + method-switch branch');
    });

    it('the method-switch branch stashes first and keeps the URL append as its session-less else', function() {
        assert.match(
            redirectBody,
            /if \(inheritedDataIsNeeded\) \{[\s\S]{0,500}?userSession\.inheritedData = requestParams;[\s\S]{0,60}?\} else \{\s*\r?\n\s*path \+= inheritedData;/
        );
    });

    it('the resumed-only conjunct is globally gone (comment-stripped)', function() {
        assert.ok(
            CODE.indexOf('userSession && local.haltedRequestUrlResumed') < 0,
            'the old resume-triggered-only gate must not survive anywhere'
        );
    });

    it('the bare unguarded userSession derivation stays absent file-wide (comment-stripped)', function() {
        assert.ok(
            CODE.indexOf('var userSession = req.session.user || req.session;') < 0,
            'only the #B75-guarded form is allowed in controller.js'
        );
    });

    it('resumeRequest: the replay stash sits after the consumer-contract write and before the flavor split', function() {
        var idxContract = resumeBody.indexOf('requestStorage.haltedRequestUrlResumed = url;');
        var idxStrip    = resumeBody.indexOf('delete data.session;');
        var idxStash    = resumeBody.indexOf('userSession.inheritedData = data;');
        var idxPopin    = resumeBody.indexOf('self.redirect(url, true);');
        assert.ok(idxContract > -1, 'the consumer-facing haltedRequestUrlResumed write must be untouched');
        assert.ok(idxStrip > -1, 'the data.session strip must exist (mirrors redirect())');
        assert.ok(idxStash > -1, 'the replay stash must exist');
        assert.ok(idxPopin > -1, 'the popin-XHR flavor dispatch must exist');
        assert.ok(idxContract < idxStash && idxStash < idxPopin,
            'stash must follow the contract write and precede the flavor split');
    });

    it('stays-put: the session-less URL fallback machinery is intact', function() {
        assert.ok(redirectBody.indexOf('path += inheritedData;') > -1, 'non-XHR URL append (fallback) intact');
        assert.ok(redirectBody.indexOf("inheritedData = '&inheritedData='") > -1, 'query-suffix build intact');
        assert.ok(redirectBody.indexOf('redirectObj.location += inheritedData;') > -1, 'XHR URL append (fallback) intact');
    });
});


// 02 — the redirect() data-crossing block, extracted from the shipped source
// and EXECUTED (real bytes, no replica): the behavior table's session-ful /
// session-less × XHR / non-XHR × size cases.
describe('02 - redirect() count>0 block — extracted-source execution', function() {

    var BLOCK = extractBlock(SRC, "if ( typeof(requestParams) != 'undefined' && ownCount(requestParams) > 0 ) {");

    it('extraction controls: content present, boundaries + self-containment hold', function() {
        assert.ok(BLOCK.indexOf('userSession.inheritedData = requestParams;') > -1, 'stash inside the block');
        assert.ok(BLOCK.indexOf('path += inheritedData;') > -1, 'fallback append inside the block');
        assert.ok(BLOCK.indexOf('Popin redirect') < 0, 'must stop before the no-params popin exit');
        assert.ok(stripComments(BLOCK).indexOf('local.') < 0, 'block must be free of per-request closure reads');
    });

    function FakeApiError(message, status) { this.message = message; this.status = status; }

    function drive(opts) {
        var calls = { renderJSON: [], throwError: [], noStore: 0 };
        var selfStub = {
            isXMLRequest: function() { return !!opts.isXhr; },
            renderJSON: function(obj) { calls.renderJSON.push(obj); },
            throwError: function(err) { calls.throwError.push(err); }
        };
        var fn = new Function(
            'req', 'path', 'requestParams', 'inheritedDataIsNeeded', 'isPopinContext',
            'self', 'encodeRFC5987ValueChars', 'ApiError', '_applyNoStoreToRedirectJSON', 'ownCount',
            BLOCK + '\n;return { path: path };'
        );
        var out = fn(
            opts.req, opts.path, opts.requestParams, !!opts.needed, !!opts.popin,
            selfStub, encodeURIComponent, FakeApiError, function() { calls.noStore++; },
            ownCountFrom(SRC)
        );
        return { out: out, calls: calls };
    }

    it('session + XHR: stashes on session.user, JSON location stays clean, no-store applied', function() {
        var user = {};
        var req = { session: { user: user } };
        var r = drive({ req: req, path: '/landing', requestParams: { k: 'v' }, isXhr: true });
        assert.deepEqual(user.inheritedData, { k: 'v' });
        assert.equal(r.calls.renderJSON.length, 1);
        assert.equal(r.calls.renderJSON[0].location, '/landing');
        assert.equal(r.calls.renderJSON[0].isXhrRedirect, true);
        assert.equal(r.calls.noStore, 1);
        assert.equal(r.calls.throwError.length, 0);
    });

    it('session WITHOUT user + XHR: stashes on the session itself (router precedence mirror)', function() {
        var session = {};
        var r = drive({ req: { session: session }, path: '/landing', requestParams: { k: 'v' }, isXhr: true });
        assert.deepEqual(session.inheritedData, { k: 'v' });
        assert.equal(r.calls.renderJSON[0].location, '/landing');
    });

    it('session + XHR + popin: stash fires, popin.url stays clean', function() {
        var user = {};
        var r = drive({ req: { session: { user: user } }, path: '/pop', requestParams: { a: 1 }, isXhr: true, popin: true });
        assert.deepEqual(user.inheritedData, { a: 1 });
        assert.equal(r.calls.renderJSON[0].popin.url, '/pop');
    });

    it('NO session + XHR: the URL fallback is byte-behavior-identical (data in clear, round-trips)', function() {
        var r = drive({ req: {}, path: '/landing', requestParams: { k: 'v v' }, isXhr: true });
        var loc = r.calls.renderJSON[0].location;
        assert.match(loc, /^\/landing\?inheritedData=/);
        var parsed = JSON.parse(decodeURIComponent(loc.split('?inheritedData=')[1]));
        assert.deepEqual(parsed, { k: 'v v' });
    });

    it('NO session + XHR + path already carrying a query: &-suffix form', function() {
        var r = drive({ req: {}, path: '/landing?x=1', requestParams: { k: 'v' }, isXhr: true });
        assert.match(r.calls.renderJSON[0].location, /^\/landing\?x=1&inheritedData=/);
    });

    it('session + non-XHR method-switch: stash fires, returned path stays clean', function() {
        var user = {};
        var r = drive({ req: { session: { user: user } }, path: '/next', requestParams: { p: 2 }, needed: true });
        assert.deepEqual(user.inheritedData, { p: 2 });
        assert.equal(r.out.path, '/next');
        assert.equal(r.calls.renderJSON.length, 0, 'non-XHR: no JSON exit from this block');
    });

    it('NO session + non-XHR method-switch: URL append exactly as before', function() {
        var r = drive({ req: {}, path: '/next', requestParams: { p: 2 }, needed: true });
        assert.match(r.out.path, /^\/next\?inheritedData=/);
    });

    it('session + non-XHR GET-to-GET (no switch): no stash, no append — the drop is preserved', function() {
        var user = {};
        var r = drive({ req: { session: { user: user } }, path: '/same', requestParams: { p: 2 }, needed: false });
        assert.equal(typeof user.inheritedData, 'undefined', 'no stash outside the method-switch gate');
        assert.equal(r.out.path, '/same');
    });

    it('NO session + oversized params: the 2000-char cap still fires (424, no response exit)', function() {
        var r = drive({ req: {}, path: '/big', requestParams: { blob: 'x'.repeat(2500) }, isXhr: true });
        assert.equal(r.calls.throwError.length, 1);
        assert.equal(r.calls.throwError[0].status, 424);
        assert.match(r.calls.throwError[0].message, /2000 chars limit/);
        assert.equal(r.calls.renderJSON.length, 0);
    });

    it('session + oversized params: NO 424 — the data rides the session instead', function() {
        var user = {};
        var r = drive({ req: { session: { user: user } }, path: '/big', requestParams: { blob: 'x'.repeat(2500) }, isXhr: true });
        assert.equal(r.calls.throwError.length, 0, 'the cap is a URL-length constraint; the session path skips it');
        assert.equal(user.inheritedData.blob.length, 2500);
        assert.equal(r.calls.renderJSON[0].location, '/big');
    });
});


// 03 — the resumeRequest() replay stash, extracted from the shipped source and
// executed. Covers the plain-XHR / non-XHR data-drop fix and its degradations.
describe('03 - resumeRequest() replay stash — extracted-source execution', function() {

    var BLOCK = extractBlock(SRC, 'if ( ownCount(data) > 0 ) {');

    it('extraction controls: the stash is inside, the flavor split is not', function() {
        assert.ok(BLOCK.indexOf('userSession.inheritedData = data;') > -1);
        assert.ok(BLOCK.indexOf('delete data.session;') > -1);
        assert.ok(BLOCK.indexOf('isPopinContext') < 0, 'must stop before the flavor split');
    });

    function drive(req, data) {
        var fn = new Function('req', 'data', 'ownCount', BLOCK);
        fn(req, data, ownCountFrom(SRC));
    }

    it('live session with user: stash lands on session.user, the session key is stripped', function() {
        var user = {};
        var data = { k: 'v', session: { leak: true } };
        drive({ session: { user: user } }, data);
        assert.deepEqual(user.inheritedData, { k: 'v' });
        assert.equal(typeof data.session, 'undefined', 'mirrors the redirect() strip');
    });

    it('live session without user: stash lands on the session itself', function() {
        var session = {};
        drive({ session: session }, { k: 'v' });
        assert.deepEqual(session.inheritedData, { k: 'v' });
    });

    it('no live session (custom requestStorage case): degrades to the old drop — no write, no throw', function() {
        assert.doesNotThrow(function() { drive({}, { k: 'v' }); });
    });

    it('empty data: no stash at all', function() {
        var user = {};
        drive({ session: { user: user } }, {});
        assert.equal(typeof user.inheritedData, 'undefined');
    });
});


// 04 — SUBTRACT: a verbatim replica of the PRE-fix gate proves the behavioral
// delta this slice ships. Under the old gate, a live session with the flag
// down (every plain self.redirect() from an action) fell to the URL branch —
// under the shipped gate the same inputs stash. The replica is what the old
// source did at the decision point; §01's globally-gone pin locks that the
// replica cannot describe the shipped source.
describe('04 - old-gate subtract: pre-fix decision URL-appends where the fix stashes', function() {

    function oldGateDecision(userSession, haltedRequestUrlResumed) {
        // pre-fix: if ( userSession && local.haltedRequestUrlResumed ) stash; else URL
        return ( userSession && haltedRequestUrlResumed ) ? 'stash' : 'url';
    }
    function newGateDecision(userSession) {
        // shipped: if ( userSession ) stash; else URL
        return ( userSession ) ? 'stash' : 'url';
    }

    it('live session, plain redirect (flag down): old=url vs new=stash — the headline change', function() {
        var session = { user: {} };
        assert.equal(oldGateDecision(session.user, false), 'url');
        assert.equal(newGateDecision(session.user), 'stash');
    });

    it('live session, resume-triggered (flag up): both stash — the popin-resume flow is preserved', function() {
        var session = { user: {} };
        assert.equal(oldGateDecision(session.user, true), 'stash');
        assert.equal(newGateDecision(session.user), 'stash');
    });

    it('session-less: both url — the fallback is identical', function() {
        assert.equal(oldGateDecision(null, false), 'url');
        assert.equal(newGateDecision(null), 'url');
    });
});
