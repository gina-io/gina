'use strict';
/**
 * #B560 — a 1-arg throwError() call with a falsy payload must still answer.
 *
 * `throwError(res, code, msg)` is polymorphic; in the 1-arg `throwError(err)`
 * shape the `res` slot holds the CALLER'S payload, not the response. The #B44
 * late-call guard bails on `!res`, which was written for the 2-arg/3-arg
 * shapes where `res` really is a possibly-released `local.res`. A falsy 1-arg
 * payload ('', null, undefined, 0, false) therefore hit that bail and was
 * swallowed: no writeHead, no end, request never answered — and the only
 * trace was a warning saying the response had been released, which then named
 * no error, because it interpolates `msg`/`code` and never `res`.
 *
 * §02 drives the REAL controller through createTestInstance (the §36
 * framework-globals bootstrap) with a recording response, so an egress is
 * asserted POSITIVELY — "did not error" would not distinguish a fix from the
 * swallow this file exists to catch.
 *
 * §02's last arm is the control that matters: a genuine 3-arg late call, with
 * a null response, must STILL bail without egressing. Without it, simply
 * deleting the guard would pass every other arm here.
 *
 * Red-first, measured against a pre-fix copy of controller.js placed in the
 * same directory (so its relative requires still resolved), with the
 * non-empty payload as the control that had to egress on BOTH sides:
 *
 *   'boom'  writeHead:500 + end   ->  writeHead:500 + end   (control, unchanged)
 *   ''      ret=false, NO calls   ->  writeHead:500 + end
 *   null    ret=false, NO calls   ->  writeHead:500 + end
 *   0       ret=false, NO calls   ->  writeHead:500 + end
 *
 * Pre-fix, each falsy payload also emitted the late-call warning; post-fix
 * none of them does.
 *
 * Usage: node --test test/core/throwerror-falsy-payload-b560.test.js
 */

var test     = require('node:test');
var describe = test.describe;
var it       = test.it;
var assert   = require('assert');
var fs       = require('fs');
var path     = require('path');

var FW     = require('../fw');
var SOURCE = path.join(FW, 'core/controller/controller.js');
var RAW    = fs.readFileSync(SOURCE, 'utf8');

describe('01 - source pins (#B560)', function () {

    it('the falsy-1-arg normalisation sits BEFORE the #B44 bail', function () {
        var norm = RAW.indexOf('if ( arguments.length === 1 && !res ) {');
        assert.ok(norm > -1, 'the #B560 normalisation is gone');

        // the #B44 bail is the `if ( !res ) {` whose body builds _b44LateError
        var bail = RAW.indexOf('var _b44LateError');
        assert.ok(bail > -1, 'the #B44 guard body is gone');
        assert.ok(norm < bail, 'the normalisation no longer precedes the #B44 bail');

        // and nothing may sit between them but the bail's own opening line
        var between = RAW.slice(norm, bail);
        assert.ok(between.indexOf('if ( !res ) {') > -1,
            'the #B44 bail no longer follows the normalisation');
    });

    it('the bail itself is unchanged — still a bare !res test (#B44 intact)', function () {
        // If someone "simplifies" this to `arguments.length !== 1 && !res`, the
        // errorObject build would deref res.error on a null payload and crash.
        assert.ok(RAW.indexOf('if ( !res ) {') > -1, 'the bare #B44 bail was rewritten');
    });
});

describe('02 - behavioural: real controller via createTestInstance (#B560)', function () {

    // Framework-globals bootstrap (§36 recipe).
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    require('module').Module._initPaths();
    require(path.join(FW, 'helpers'));
    setPath('gina', { core: path.join(FW, 'core') });
    var SuperController = require(SOURCE);

    /**
     * A response that records whether anything was written to it.
     *
     * @inner
     * @returns {object} recording response double
     */
    function recordingRes() {
        var rec = { wroteHead: null, ended: false, headers: {}, chunks: [] };
        return {
            _rec        : rec,
            headersSent : false,
            setHeader   : function (k, v) { rec.headers[k] = v; },
            getHeaders  : function () { return rec.headers; },
            getHeader   : function (k) { return rec.headers[k]; },
            writeHead   : function (c, h) { rec.wroteHead = c; if (h) { Object.keys(h).forEach(function (k) { rec.headers[k] = h[k]; }); } },
            write       : function (c) { rec.chunks.push(String(c)); },
            end         : function (c) { rec.ended = true; if (c) { rec.chunks.push(String(c)); } }
        };
    }

    /**
     * Fresh controller bound to a recording response.
     *
     * @inner
     * @returns {object} { inst, res }
     */
    function make() {
        var res = recordingRes();
        var inst = SuperController.createTestInstance({
            req     : { method: 'GET', url: '/t', httpVersion: '1.1', headers: {}, params: {}, get: {}, post: {} },
            res     : res,
            options : {
                conf : {
                    bundle   : 'b',
                    encoding : { charset: 'utf-8' },
                    server   : {
                        protocol          : 'http/1.1',
                        coreConfiguration : { mime: { json: 'application/json', html: 'text/html' } }
                    },
                    content  : { routing: { _test: {} } }
                },
                rule : '_test'
            }
        });
        return { inst: inst, res: res };
    }

    /**
     * Did anything at all reach the wire?
     *
     * @inner
     * @param {object} res - recording response
     * @returns {boolean} true when a status or a body was written
     */
    function egressed(res) {
        return res._rec.wroteHead !== null || res._rec.ended === true || res._rec.chunks.length > 0;
    }

    it('CONTROL: a non-empty 1-arg string egresses (proves the harness can observe one)', function () {
        var m = make();
        m.inst.throwError('boom-b560');
        assert.ok(egressed(m.res),
            'the harness saw no egress even for a non-empty payload — it cannot observe one, so every other arm here is void');
    });

    it('an EMPTY-string payload egresses instead of being swallowed', function () {
        var m = make();
        m.inst.throwError('');
        assert.ok(egressed(m.res), 'throwError(\'\') wrote nothing — the request would never be answered');
    });

    it('a null payload egresses and does not crash on the errorObject build', function () {
        var m = make();
        assert.doesNotThrow(function () { m.inst.throwError(null); });
        assert.ok(egressed(m.res), 'throwError(null) wrote nothing');
    });

    it('a 0 payload egresses', function () {
        var m = make();
        m.inst.throwError(0);
        assert.ok(egressed(m.res), 'throwError(0) wrote nothing');
    });

    it('CONTROL: a genuine 3-arg late call on a released response STILL bails (#B44 intact)', function () {
        var m = make();
        var out = m.inst.throwError(null, 500, 'late');
        assert.equal(out, false, 'the late-call guard no longer returns false');
        assert.equal(egressed(m.res), false,
            'a late call wrote to the response — the #B44 guard was weakened, not preserved');
    });
});
