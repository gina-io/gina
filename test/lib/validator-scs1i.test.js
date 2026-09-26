'use strict';
var path   = require('path');
var fs     = require('fs');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW           = require('../fw');
var FORM_VAL_SRC = fs.readFileSync(path.join(FW, 'core/plugins/lib/validator/src/form-validator.js'), 'utf8');
var MAIN_SRC     = fs.readFileSync(path.join(FW, 'core/plugins/lib/validator/src/main.js'), 'utf8');

// #M21c — Pattern B trust-model invariant test.
//
// The compile site in `core/plugins/lib/validator/src/form-validator.js`
// (`self[el][v] = compileUserValidator(v, userValidator)` — since #M21d an
// inline <script> the browser compiles; before it, an eval of the same string)
// is load-bearing: it constructs a callable from a user-defined validator's
// function body. The trust assumption is that `userValidator` is sourced from
// disk-loaded `bundle/validators/<name>/main.js` files at framework boot,
// registered on `gina.forms.validators`. No request-time input is permitted
// to reach this surface.
//
// This file pins the invariant as source-side assertions. Future maintainers
// who break the invariant (e.g. by adding a request-time write to
// `gina.forms.validators`, or by sourcing `userValidator` from a request
// object) will see a failing test instead of a silent regression.

var stripComments = function (src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
};

// Slice a window around the compile site to scope the request-token assertions.
// The compile call lives inside the `if (hasUserValidators())` block; bound the
// window to that conditional's open/close, with a small safety margin.
var sliceUserValidatorBlock = function (src) {
    var start = src.indexOf('if ( hasUserValidators() ) {');
    if (start < 0) {
        throw new Error('cannot locate hasUserValidators block in form-validator.js');
    }
    // From the `if` open through ~80 lines (enough to cover the for-loop and the compile call).
    return src.slice(start, start + 4000);
};


// --- 01 — read sites unchanged (the framework only READS gina.forms.validators) ---
describe('01 — gina.forms.validators read-chain (#M21c)', function () {

    it('form-validator.js: iterates gina.forms.validators in the user-validator merge block', function () {
        assert.ok(
            /for\s*\(\s*let\s+v\s+in\s+gina\.forms\.validators\s*\)/.test(FORM_VAL_SRC),
            'expected `for (let v in gina.forms.validators)` iteration'
        );
    });

    it('form-validator.js: userValidator is sourced from gina.forms.validators[v] only (two known shapes)', function () {
        // (a) Buffer-shaped: `bufferToString(gina.forms.validators[v].data)`
        // (b) Function-shaped: attached as it is (#M21d — was a `.toString()` round trip)
        var live = stripComments(FORM_VAL_SRC);
        var bufferShape   = /userValidator\s*=\s*bufferToString\s*\(\s*gina\.forms\.validators\[v\]\.data\s*\)/.test(live);
        var functionShape = /self\[el\]\[v\]\s*=\s*gina\.forms\.validators\[v\];/.test(live);
        assert.ok(bufferShape,   'expected the buffer-shape userValidator source (gina.forms.validators[v].data)');
        assert.ok(functionShape, 'expected the function-shape registration attached as it is (self[el][v] = gina.forms.validators[v])');
    });

    it('form-validator.js: the compile site uses the prepared userValidator (no other source)', function () {
        var live = stripComments(FORM_VAL_SRC);
        assert.ok(
            /compileUserValidator\s*\(\s*v\s*,\s*userValidator\s*\)/.test(live),
            'compile input chain does not match `compileUserValidator(v, userValidator)`'
        );
    });
});


// --- 02 — write-surface invariant: no writes to gina.forms.validators ---
describe('02 — gina.forms.validators write-surface (#M21c)', function () {

    it('form-validator.js: zero writes to gina.forms.validators[...]', function () {
        var live = stripComments(FORM_VAL_SRC);
        assert.ok(
            !/gina\.forms\.validators\s*(?:\[[^\]]*\])?\s*=[^=]/.test(live),
            'form-validator.js writes to gina.forms.validators — invariant breach'
        );
    });

    it('validator/main.js: zero writes to gina.forms.validators[...]', function () {
        var live = stripComments(MAIN_SRC);
        assert.ok(
            !/gina\.forms\.validators\s*(?:\[[^\]]*\])?\s*=[^=]/.test(live),
            'main.js writes to gina.forms.validators — invariant breach'
        );
    });
});


// --- 03 — request-time identifiers MUST NOT appear in the userValidator block ---
describe('03 — no request-time identifiers in the compile block (#M21c)', function () {

    var block = sliceUserValidatorBlock(stripComments(FORM_VAL_SRC));

    it('block does not reference `req.` (request object property access)', function () {
        assert.ok(!/\breq\./.test(block), 'block touches req. — invariant breach');
    });

    it('block does not reference `request.` (request object property access)', function () {
        assert.ok(!/\brequest\./.test(block), 'block touches request. — invariant breach');
    });

    it('block does not reference `req[` (request object bracket access)', function () {
        assert.ok(!/\breq\[/.test(block), 'block touches req[ — invariant breach');
    });

    it('block does not reference `request[` (request object bracket access)', function () {
        assert.ok(!/\brequest\[/.test(block), 'block touches request[ — invariant breach');
    });

    it('block does not pull from request body / query / params shortcuts', function () {
        assert.ok(!/\.body\b/.test(block),  'block touches .body — invariant breach');
        assert.ok(!/\.query\b/.test(block), 'block touches .query — invariant breach');
        assert.ok(!/\.params\b/.test(block), 'block touches .params — invariant breach');
    });
});


// --- 04 — JSDoc / provenance presence ---
describe('04 — #M21c provenance + trust-model comment', function () {

    it('form-validator.js: carries the #M21c provenance tag at the compile site', function () {
        assert.ok(/#M21c/.test(FORM_VAL_SRC), '#M21c tag missing');
    });

    it('form-validator.js: comment block names the trust assumption ("disk-sourced at boot")', function () {
        assert.ok(
            /disk-sourced at boot/.test(FORM_VAL_SRC),
            'trust-model comment missing the "disk-sourced at boot" phrase'
        );
    });

    it('form-validator.js: comment block names the invariant test file', function () {
        assert.ok(
            /validator-scs1i\.test\.js/.test(FORM_VAL_SRC),
            'comment does not reference test/lib/validator-scs1i.test.js'
        );
    });

    it('form-validator.js: comment names the request-time exclusion explicitly', function () {
        assert.ok(
            /req\.\*|request\.\*/.test(FORM_VAL_SRC),
            'trust-model comment does not mention req.* / request.* exclusion'
        );
    });
});
