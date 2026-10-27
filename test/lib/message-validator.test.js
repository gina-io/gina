'use strict';
/**
 * lib/message-validator — the #FIN3 pluggable message-schema validation seam.
 *
 * The APPLICATION supplies the validator (a factory module at
 * `message-validators/<name>.js`); the framework supplies the boot registry,
 * the async-capable router-band gate and the fail-closed 400/422/503 shape.
 * A route opts in with `routing.json` `param.messageValidator`.
 *
 * Shape of this suite:
 *   §01 wiring pins — the two router.js gate sites (ahead of the DTO pipe),
 *       the lib/index.js plain-require, the GinaLib declaration, the
 *       core/server.js boot registrar (after the DTO walk, before the authz
 *       lint), and the controller.js error-envelope `errors` merge disjunct.
 *   §02 register() — factory contract behaviorals against REAL fixture files
 *       (runs once, cached on re-register, null on every unresolvable shape,
 *       factory throw propagates to the caller).
 *   §03 gate dormancy — an undeclared route returns null SYNCHRONOUSLY and
 *       mints zero promises (the band's dormancy rule).
 *   §04 gate verdicts — the REAL gate driven end-to-end with a spy controller:
 *       allow, default-422, errors passthrough, 400, 503 + Retry-After,
 *       contract violations -> 500, sync/async validators, throw/reject ->
 *       fail-closed 500, the verbatim document read.
 *
 * Every §01 pin was validated red-first against the pre-change bytes
 * (`git show HEAD:<file>`) through a discriminating checker carrying a
 * non-discriminating control arm and a deliberately-wrong-expectation arm.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');

var FW = require('../fw');

// The registry lives on process.gina (created by gna.js in a real bundle) —
// seed it here so the standalone require does not deref undefined.
if ( !process.gina ) { process.gina = {}; }

var LIB_PATH   = path.join(FW, 'lib/message-validator/src/main.js');
var msv        = require(LIB_PATH);

var ROUTER_SRC = fs.readFileSync(path.join(FW, 'core/router.js'), 'utf8');
var LIBIDX_SRC = fs.readFileSync(path.join(FW, 'lib/index.js'), 'utf8');
var SERVER_SRC = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var CTRL_SRC   = fs.readFileSync(path.join(FW, 'core/controller/controller.js'), 'utf8');
var TYPES_SRC  = fs.readFileSync(path.join(FW, '../../types/index.d.ts'), 'utf8');

/**
 * Strip `//` line comments so negative/positional pins cannot anchor on prose
 * (the own-comment trap — a guard's explanatory comment names what it guards).
 */
function stripLineComments(src) {
    return src.split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
}

/** A minimal spy controller whose throwError records every call. */
function makeSpyController() {
    var calls = [];
    return {
        calls      : calls,
        throwError : function (errorObject) { calls.push(errorObject); return false; }
    };
}

/** A minimal spy response recording setHeader writes. */
function makeSpyResponse() {
    var headers = {};
    return {
        headersSent : false,
        headers     : headers,
        setHeader   : function (k, v) { headers[k] = v; }
    };
}

/** A request shape carrying the opt-in + a raw body. */
function makeRequest(validatorName, rawBody) {
    return {
        routing : { rule: 'msv-test-rule', param: { messageValidator: validatorName } },
        rawBody : rawBody
    };
}


describe('message-validator §01 — wiring pins', function () {

    it('01.1 - router.js calls the gate at BOTH dispatch sites', function () {
        assert.equal(
            (ROUTER_SRC.match(/messageValidator\.gate\(request, response, controller\)/g) || []).length, 2,
            'expected the gate call at both router dispatch sites');
        assert.equal(
            (ROUTER_SRC.match(/var _msvDispatchBand = function/g) || []).length, 2,
            'expected the wrapped band continuation at both sites');
        assert.equal(
            (ROUTER_SRC.match(/if \(proceed\) \{ _msvDispatchBand\(\); \}/g) || []).length, 2,
            'the allow arm must continue the band at both sites');
        assert.equal(
            (ROUTER_SRC.match(/\.catch\(function onMessageValidatorError\(/g) || []).length, 2,
            'the last-resort belt must exist at both sites');
    });

    it('01.2 - per site: the gate precedes the DTO pipe (document-level before field-level)', function () {
        var re = /var _dispatchControllerAction = function/g, m, seen = 0;
        while ((m = re.exec(ROUTER_SRC)) !== null) {
            var after   = ROUTER_SRC.slice(m.index);
            var gateIdx = after.indexOf('messageValidator.gate(request, response, controller)');
            var dtoIdx  = after.indexOf('dtoPipe.validateRequestPayload');
            assert.ok(gateIdx > -1 && dtoIdx > -1, 'landmarks missing in a dispatch slice');
            assert.ok(gateIdx < dtoIdx, 'the message-schema gate must run BEFORE the DTO pipe');
            seen++;
        }
        assert.equal(seen, 2);
    });

    it('01.3 - router.js binds the lib once, beside its band siblings', function () {
        assert.match(ROUTER_SRC, /messageValidator\s*=\s*lib\.messageValidator/);
    });

    it('01.4 - lib/index.js plain-requires the lib (never _require — the band-gate discipline)', function () {
        assert.match(LIBIDX_SRC, /messageValidator\s*:\s*require\('\.\/message-validator'\)/);
        assert.doesNotMatch(LIBIDX_SRC, /messageValidator\s*:\s*_require\(/);
    });

    it('01.5 - GinaLib declares messageValidator (the two-way types parity gate)', function () {
        assert.ok(TYPES_SRC.indexOf('messageValidator: any;') > -1);
    });

    it('01.6 - core/server.js registers route validators at BOOT, between the DTO walk and the authz lint', function () {
        var dtoIdx  = SERVER_SRC.indexOf('lib.dto.load(_dtoSrcPath');
        var msvIdx  = SERVER_SRC.indexOf('lib.messageValidator.register(_msvSrcPath');
        var authIdx = SERVER_SRC.indexOf('#COMPLY1 — lint every declared authorization flag');
        assert.ok(dtoIdx > -1 && msvIdx > -1 && authIdx > -1, 'boot landmarks missing');
        assert.ok(msvIdx > dtoIdx,  'the validator walk must follow the DTO registrar');
        assert.ok(msvIdx < authIdx, 'the validator walk must precede the authz lint (inside init\'s try — the #B57 catch owns its throws)');
    });

    it('01.7 - the boot walk refuses every unresolvable shape loudly', function () {
        assert.ok(SERVER_SRC.indexOf('`param.messageValidator` must be a string') > -1,
            'a non-string declaration must refuse the boot');
        assert.ok(SERVER_SRC.indexOf('could not be registered from') > -1,
            'a require/factory throw must be wrapped into a route-naming boot refusal');
        assert.ok(SERVER_SRC.indexOf('is missing, does not export a factory function, or its factory did not return a validate function') > -1,
            'an unresolvable module must refuse the boot naming the full contract');
    });

    it('01.8 - controller.js merges a top-level `errors` array into the error envelope (the fields/flash sibling)', function () {
        var code = stripLineComments(CTRL_SRC);
        var flashIdx  = code.indexOf("typeof(res.flash) != 'undefined'");
        var errorsIdx = code.indexOf("typeof(res.errors) != 'undefined'");
        var mergeIdx  = code.indexOf('errorObject = merge(renderData.copyOwn(arguments[arguments.length-1]), errorObject)');
        assert.ok(flashIdx > -1, 'anti-vacuity: the stripped source must still carry the pre-existing flash disjunct');
        assert.ok(errorsIdx > -1, 'the errors disjunct must exist in CODE (not a comment)');
        assert.ok(mergeIdx > errorsIdx, 'the errors disjunct must gate the ApiError merge');
        assert.ok(errorsIdx > flashIdx, 'the errors disjunct extends the existing condition');
    });
});


describe('message-validator §02 — register() factory contract (real fixture files)', function () {

    var tmpDir = null;

    before(function () {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-msv-'));
        var dir = path.join(tmpDir, 'message-validators');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'ok.js'),
            'var runs = 0;\n' +
            'module.exports = function factory(ctx) {\n' +
            '    runs++;\n' +
            '    module.exports._runs = runs;\n' +
            '    module.exports._ctx  = ctx;\n' +
            '    return function validate(document, req) { return { valid: true }; };\n' +
            '};\n');
        fs.writeFileSync(path.join(dir, 'notafactory.js'),
            'module.exports = { validate: function () {} };\n');
        fs.writeFileSync(path.join(dir, 'badreturn.js'),
            'module.exports = function factory() { return { not: "a function" }; };\n');
        fs.writeFileSync(path.join(dir, 'throwing.js'),
            'module.exports = function factory() { throw new Error("schema file unreadable"); };\n');
    });

    it('02.1 - a factory module registers: the factory runs ONCE with ctx, the validate fn is returned', function () {
        var fn = msv.register(tmpDir, 'ok', { bundle: 'b', env: 'dev' });
        assert.equal(typeof fn, 'function');
        var mod = require(path.join(tmpDir, 'message-validators', 'ok.js'));
        assert.equal(mod._runs, 1, 'the factory must run exactly once at registration');
        assert.deepEqual(mod._ctx, { bundle: 'b', env: 'dev' }, 'the factory receives { bundle, env }');
    });

    it('02.2 - re-registering a name returns the cached fn without re-running the factory', function () {
        var first  = msv.register(tmpDir, 'ok', { bundle: 'b', env: 'dev' });
        var second = msv.register(tmpDir, 'ok', { bundle: 'b', env: 'dev' });
        assert.equal(second, first);
        var mod = require(path.join(tmpDir, 'message-validators', 'ok.js'));
        assert.equal(mod._runs, 1, 'the factory must NOT re-run for an already-registered name');
    });

    it('02.3 - a missing file resolves null (the caller turns it into the boot refusal)', function () {
        assert.equal(msv.register(tmpDir, 'no-such-validator', { bundle: 'b', env: 'dev' }), null);
    });

    it('02.4 - a module that does not export a function resolves null', function () {
        assert.equal(msv.register(tmpDir, 'notafactory', { bundle: 'b', env: 'dev' }), null);
    });

    it('02.5 - a factory that does not return a function resolves null', function () {
        assert.equal(msv.register(tmpDir, 'badreturn', { bundle: 'b', env: 'dev' }), null);
    });

    it('02.6 - a factory throw PROPAGATES (this is the boot dry-run — deploy-time failure)', function () {
        assert.throws(function () {
            msv.register(tmpDir, 'throwing', { bundle: 'b', env: 'dev' });
        }, /schema file unreadable/);
    });

    it('02.7 - get() reads the registry; an unknown name is null', function () {
        assert.equal(typeof msv.get('ok'), 'function');
        assert.equal(msv.get('never-registered'), null);
    });
});


describe('message-validator §03 — gate dormancy (zero promises)', function () {

    it('03.1 - a route with no param.messageValidator returns null SYNCHRONOUSLY', function () {
        var req = { routing: { rule: 'r', param: { control: 'x' } }, rawBody: 'ignored' };
        assert.equal(msv.gate(req, makeSpyResponse(), makeSpyController()), null);
    });

    it('03.2 - a missing routing / param object is dormant, never a throw', function () {
        assert.equal(msv.gate({}, makeSpyResponse(), makeSpyController()), null);
        assert.equal(msv.gate({ routing: {} }, makeSpyResponse(), makeSpyController()), null);
        assert.equal(msv.gate(null, makeSpyResponse(), makeSpyController()), null);
    });

    it('03.3 - an empty-string or non-string declaration is dormant at the gate (boot already refused it)', function () {
        assert.equal(msv.gate(makeRequest('', 'x'), makeSpyResponse(), makeSpyController()), null);
        assert.equal(msv.gate(makeRequest(42, 'x'), makeSpyResponse(), makeSpyController()), null);
    });
});


describe('message-validator §04 — gate verdicts (the REAL gate, spy controller)', function () {

    /** Register an inline validator under a unique name and build the drive kit. */
    function arm(name, validateFn, rawBody) {
        process.gina._messageValidators[name] = validateFn;
        return {
            req  : makeRequest(name, rawBody),
            res  : makeSpyResponse(),
            ctrl : makeSpyController()
        };
    }

    it('04.01 - a declared-but-unregistered name is a LOUD 500, never a silent skip', async function () {
        var k = { req: makeRequest('msv-unregistered-name', '<doc/>'), res: makeSpyResponse(), ctrl: makeSpyController() };
        var g = msv.gate(k.req, k.res, k.ctrl);
        assert.ok(g && typeof g.then === 'function', 'an armed route must return a promise');
        assert.equal(await g, false);
        assert.equal(k.ctrl.calls.length, 1);
        assert.equal(k.ctrl.calls[0].status, 500);
        assert.match(k.ctrl.calls[0].error, /msv-test-rule/);
        assert.match(k.ctrl.calls[0].error, /msv-unregistered-name/);
    });

    it('04.02 - { valid: true } proceeds: resolves true, throwError never called', async function () {
        var k = arm('msv-allow', function () { return { valid: true }; }, '<doc/>');
        assert.equal(await msv.gate(k.req, k.res, k.ctrl), true);
        assert.equal(k.ctrl.calls.length, 0);
    });

    it('04.03 - { valid: false } with no status is a 422 with the refusal sentence', async function () {
        var k = arm('msv-invalid-default', function () { return { valid: false }; }, '<doc/>');
        assert.equal(await msv.gate(k.req, k.res, k.ctrl), false);
        assert.equal(k.ctrl.calls.length, 1);
        assert.equal(k.ctrl.calls[0].status, 422);
        assert.equal(k.ctrl.calls[0].error, 'Message validation failed');
        assert.equal(typeof k.ctrl.calls[0].errors, 'undefined', 'no errors key when the verdict carried none');
    });

    it('04.04 - the errors ARRAY is forwarded verbatim on the refusal object', async function () {
        var report = [ { message: 'IBAN checksum failed', line: 12, column: 8 }, { message: 'missing element', path: '/Document/CstmrCdtTrfInitn' } ];
        var k = arm('msv-errors', function () { return { valid: false, errors: report }; }, '<doc/>');
        await msv.gate(k.req, k.res, k.ctrl);
        assert.equal(k.ctrl.calls[0].status, 422);
        assert.equal(k.ctrl.calls[0].errors, report, 'the array must be forwarded by reference, untruncated');
    });

    it('04.05 - a non-array errors value is dropped (the contract says array)', async function () {
        var k = arm('msv-errors-nonarray', function () { return { valid: false, errors: 'oops' }; }, '<doc/>');
        await msv.gate(k.req, k.res, k.ctrl);
        assert.equal(k.ctrl.calls[0].status, 422);
        assert.equal(typeof k.ctrl.calls[0].errors, 'undefined');
    });

    it('04.06 - status 400 (not parseable) is honoured', async function () {
        var k = arm('msv-400', function () { return { valid: false, status: 400, errors: [{ message: 'not XML' }] }; }, 'garbage');
        await msv.gate(k.req, k.res, k.ctrl);
        assert.equal(k.ctrl.calls[0].status, 400);
        assert.equal(k.ctrl.calls[0].error, 'Message validation failed');
    });

    it('04.07 - status 503 (checker unavailable) sets Retry-After and carries the outage sentence, no errors', async function () {
        var k = arm('msv-503', function () { return { valid: false, status: 503, retryAfter: 30, errors: [{ message: 'x' }] }; }, '<doc/>');
        await msv.gate(k.req, k.res, k.ctrl);
        assert.equal(k.ctrl.calls[0].status, 503);
        assert.equal(k.ctrl.calls[0].error, 'Message validation is temporarily unavailable');
        assert.equal(typeof k.ctrl.calls[0].errors, 'undefined', 'a 503 is about the CHECKER, not the document');
        assert.equal(k.res.headers['Retry-After'], '30');
    });

    it('04.08 - 503 without retryAfter sets no header; a fractional retryAfter is ceiled', async function () {
        var k1 = arm('msv-503-bare', function () { return { valid: false, status: 503 }; }, '<doc/>');
        await msv.gate(k1.req, k1.res, k1.ctrl);
        assert.equal(typeof k1.res.headers['Retry-After'], 'undefined');

        var k2 = arm('msv-503-frac', function () { return { valid: false, status: 503, retryAfter: 2.5 }; }, '<doc/>');
        await msv.gate(k2.req, k2.res, k2.ctrl);
        assert.equal(k2.res.headers['Retry-After'], '3');
    });

    it('04.09 - an unsupported refusal status is a 500 contract violation, fail-closed', async function () {
        var k = arm('msv-418', function () { return { valid: false, status: 418 }; }, '<doc/>');
        assert.equal(await msv.gate(k.req, k.res, k.ctrl), false);
        assert.equal(k.ctrl.calls[0].status, 500);
        assert.match(k.ctrl.calls[0].error, /unsupported refusal status `418`/);
    });

    it('04.10 - a non-verdict return (boolean, undefined, valid non-boolean) is a 500 contract violation', async function () {
        var shapes = [
            [ 'msv-shape-bool',    function () { return true; } ],
            [ 'msv-shape-undef',   function () { /* returns undefined */ } ],
            [ 'msv-shape-truthy',  function () { return { valid: 'yes' }; } ]
        ];
        for (var i = 0; i < shapes.length; i++) {
            var k = arm(shapes[i][0], shapes[i][1], '<doc/>');
            assert.equal(await msv.gate(k.req, k.res, k.ctrl), false, shapes[i][0]);
            assert.equal(k.ctrl.calls[0].status, 500, shapes[i][0]);
            assert.match(k.ctrl.calls[0].error, /unsupported verdict shape/, shapes[i][0]);
        }
    });

    it('04.11 - a SYNC validator throw is a fail-closed 500 naming the validator', async function () {
        var k = arm('msv-throws', function () { throw new Error('sidecar exploded'); }, '<doc/>');
        assert.equal(await msv.gate(k.req, k.res, k.ctrl), false);
        assert.equal(k.ctrl.calls[0].status, 500);
        assert.match(k.ctrl.calls[0].error, /msv-throws/);
        assert.match(k.ctrl.calls[0].error, /sidecar exploded/);
    });

    it('04.12 - an ASYNC validator works: resolution proceeds, rejection is the same fail-closed 500', async function () {
        var kOk = arm('msv-async-ok', function () {
            return new Promise(function (resolve) { setTimeout(function () { resolve({ valid: true }); }, 5); });
        }, '<doc/>');
        assert.equal(await msv.gate(kOk.req, kOk.res, kOk.ctrl), true);
        assert.equal(kOk.ctrl.calls.length, 0);

        var kRej = arm('msv-async-rej', function () { return Promise.reject(new Error('conn refused')); }, '<doc/>');
        assert.equal(await msv.gate(kRej.req, kRej.res, kRej.ctrl), false);
        assert.equal(kRej.ctrl.calls[0].status, 500);
        assert.match(kRej.ctrl.calls[0].error, /conn refused/);
    });

    it('04.13 - the validator receives the VERBATIM rawBody string and the live request', async function () {
        var seen = null;
        var body = '<?xml version="1.0"?>\n<Document xmlns="urn:iso:std:iso:20022"><CstmrCdtTrfInitn/></Document>';
        var k = arm('msv-input', function (document, req) { seen = { document: document, req: req }; return { valid: true }; }, body);
        await msv.gate(k.req, k.res, k.ctrl);
        assert.equal(seen.document, body, 'the document must be the verbatim raw body');
        assert.equal(seen.req, k.req, 'the second argument must be the live request');
    });

    it('04.14 - a non-string rawBody (multipart / body-less) delivers the empty string, never undefined', async function () {
        var seen = null;
        var k = arm('msv-nobody', function (document) { seen = document; return { valid: true }; }, undefined);
        await msv.gate(k.req, k.res, k.ctrl);
        assert.equal(seen, '');
    });

    it('04.15 - a header write on a sent/broken response never masks the 503 (best-effort belt)', async function () {
        var k = arm('msv-503-sent', function () { return { valid: false, status: 503, retryAfter: 10 }; }, '<doc/>');
        k.res.headersSent = true;
        assert.equal(await msv.gate(k.req, k.res, k.ctrl), false);
        assert.equal(k.ctrl.calls[0].status, 503, 'the 503 itself is the contract');
        assert.equal(typeof k.res.headers['Retry-After'], 'undefined');

        var k2 = arm('msv-503-broken', function () { return { valid: false, status: 503, retryAfter: 10 }; }, '<doc/>');
        k2.res.setHeader = function () { throw new Error('stream gone'); };
        assert.equal(await msv.gate(k2.req, k2.res, k2.ctrl), false);
        assert.equal(k2.ctrl.calls[0].status, 503);
    });
});
