'use strict';
/**
 * #M21d — the last live `eval` leaves the validator engine.
 *
 * A custom validator (`src/<bundle>/forms/validators/<name>/main.js`) reaches the browser as
 * source text inside the page's inline bootstrap and used to become a function through
 * `eval('(' + source + ')')` — the one dynamic-code call left in the engine after #M20–#M22,
 * kept under the #M21c trust model (the source is disk-loaded at boot, never request input).
 * A supply-chain scanner flags the call on some published versions and not others, so the
 * package's score flipped between two values on identical bytes.
 *
 * The engine now compiles the source the way the page delivered it: `compileUserValidator`
 * inserts an inline `<script>` that assigns the function to
 * `gina.forms.compiledValidators[name]` (a sibling of the read-only source registry), copies
 * an existing script's CSP nonce onto it, runs synchronously, and removes it. The scope
 * contract is unchanged — the prologue the engine splices into the body already hands it
 * `self` / `local` / `isGFFCtx` / `replace` through `this.getValidationContext()`. On the
 * server, where the registration path is not wired (the published reference says
 * browser-only), a function-shaped registration is used as it is and a source-shaped one is
 * refused with a message naming the contract.
 *
 * Shape: (a) source pins on the engine (comment-stripped: zero live dynamic-code calls, the
 * compile call inside the browser branch, the two server branches); (b) the EXTRACTED real
 * bytes of `compileUserValidator` executed under jsdom (`runScripts: 'dangerously'`) — a
 * source compiles into the registry and is reused, the nonce is copied, nothing stays in the
 * DOM, a SyntaxError is refused with the documented message; (c) the real engine on the
 * server: a registered function is attached by IDENTITY (the retired round trip produced a
 * copy), a source-shaped registration throws the browser-only message.
 *
 * Red-first seam: `GINA_FORM_VALIDATOR_SRC` points the whole file — pins, extraction and the
 * real-engine arms — at another copy of the engine (a `git show HEAD:` extract with its
 * sibling dirs symlinked), so every arm was validated red on the pre-change bytes without
 * touching the shared working tree.
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var { JSDOM } = require('jsdom');

var FW = require('../fw');

process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
process.setMaxListeners(0); // engine construction adds logger listeners per instance
require(path.join(FW, 'helpers'));
/* global getContext, setContext */
if (typeof getContext('gina') === 'undefined') { setContext('gina', {}); }

var ENGINE_PATH = process.env.GINA_FORM_VALIDATOR_SRC ||
    path.join(FW, 'core/plugins/lib/validator/src/form-validator.js');
var ENGINE_SRC  = fs.readFileSync(ENGINE_PATH, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}
var LIVE = stripComments(ENGINE_SRC);

// Brace-walk extraction of the shipped `compileUserValidator` (started-flag walker: the
// body carries no brace inside a string or regex literal — asserted by the round trip
// below, which would not compile otherwise). Anchored on the line-start DECLARATION so
// the JSDoc `@example` naming the call cannot match.
var DECL_RE = /^[ \t]*function compileUserValidator\(name, source\) \{/mg;
function extractCompile(src) {
    var matches = src.match(DECL_RE) || [];
    if (matches.length !== 1) { return null; }
    var start = src.search(DECL_RE);
    var depth = 0, started = false, i = start;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}
var COMPILE_SRC = extractCompile(ENGINE_SRC);

/** A jsdom page with (optionally) one nonced script, sharing `gina` with this process. */
function page(opts) {
    opts = opts || {};
    var head = opts.nonce ? '<script nonce="' + opts.nonce + '">window.__seed = 1;</script>' : '';
    var dom = new JSDOM('<!DOCTYPE html><html><head>' + head + '</head><body></body></html>',
        { runScripts: 'dangerously' });
    var win = dom.window;
    var gina = { forms: { validators: {} } };
    win.gina = gina;
    // the shipped bytes, compiled inside the page's realm so `document` / `gina` / `JSON`
    // resolve to the window's own
    var compile = new win.Function('return (' + COMPILE_SRC.replace(/^[ \t]*function compileUserValidator/, 'function compileUserValidator') + ');')();
    var errors = [];
    dom.virtualConsole.on('jsdomError', function (e) { errors.push(String(e && e.message || e)); });
    return { dom: dom, win: win, doc: win.document, gina: gina, compile: compile, errors: errors };
}

// The source shape the caller hands over: a validator body with the engine's prologue
// already spliced after the opening brace (the same replace the engine performs).
var PROLOGUE = 'var validationContext = this.getValidationContext(),isGFFCtx = validationContext.isGFFCtx,self = validationContext.self,local = validationContext.local,replace = validationContext.replace;';
var SIREN_LIKE = ('function FormValidateIsSirenLike(errorMessage, errorStack) {\n' +
    '    var digits = String(this.value).replace(/\\s+/g, "");\n' +
    '    this.valid = /^[0-9]{9}$/.test(digits) && isGFFCtx === true && typeof(self) === "object" && typeof(replace) === "function";\n' +
    '    if (!this.valid) { local.errorLabels.sirenLike = errorMessage; }\n' +
    '    return this.valid;\n' +
    '}').replace(/(\)\s+\{|\)\{){1}/, '$&\n\t' + PROLOGUE);

function fieldCtx(value, isGFFCtx) {
    var local = { errorLabels: {} };
    return {
        value: value,
        getValidationContext: function () {
            return { isGFFCtx: isGFFCtx, self: {}, local: local, replace: function (s) { return s; } };
        },
        local: local
    };
}


describe('01 — source pins (#M21d)', function () {

    it('01.1 the engine carries zero live eval( / Function( calls (comments stripped)', function () {
        var m = /(^|[^\w.$])(eval|Function)\s*\(/.exec(LIVE);
        assert.equal(m, null, 'live dynamic-code call left in form-validator.js near: ' +
            (m ? JSON.stringify(LIVE.slice(Math.max(0, m.index - 60), m.index + 40)) : ''));
    });

    it('01.2 the strip did work: the raw source still names eval in its comments (control)', function () {
        assert.ok(/eval/.test(ENGINE_SRC), 'the raw source no longer mentions eval at all — the pin above is unverifiable');
        assert.ok(/hasUserValidators\(\)/.test(LIVE), 'stripping emptied the file — the pin above would pass vacuously');
    });

    it('01.3 the browser branch compiles through compileUserValidator with the prepared source', function () {
        var block = LIVE.slice(LIVE.indexOf('if ( hasUserValidators() ) {'));
        block = block.slice(0, block.indexOf('} // EO addField(el, value)'));
        assert.ok(block.length > 0, 'user-validator block not found');
        assert.match(block, /if \( isGFFCtx \) \{[\s\S]*?self\[el\]\[v\] = compileUserValidator\(v, userValidator\);/,
            'the isGFFCtx branch must assign compileUserValidator(v, userValidator)');
        assert.match(block, /userValidator = userValidator\.replace\(\/\(\\\)\\s\+\\\{\|\\\)\\\{\)\{1\}\/, '\$&\\n\\t'\+ passedContext\);/,
            'the prologue splice must precede the compile (the scope contract lives there)');
    });

    it('01.4 the server branches: a function-shaped registration is used as it is, a source-shaped one is refused', function () {
        assert.match(LIVE, /else if \( typeof\(gina\.forms\.validators\[v\]\) === 'function' \) \{\s*self\[el\]\[v\] = gina\.forms\.validators\[v\];/);
        assert.match(LIVE, /throw new Error\('\[UserFormValidator\] custom validators run in the browser only/);
    });

    it('01.5 compileUserValidator is declared exactly once and extracts (the harness control)', function () {
        assert.equal((ENGINE_SRC.match(DECL_RE) || []).length, 1);
        assert.ok(COMPILE_SRC && /^\s*function compileUserValidator/.test(COMPILE_SRC) && /\}\s*$/.test(COMPILE_SRC), 'extraction failed');
        assert.ok(COMPILE_SRC.indexOf('gina.forms.compiledValidators') > -1, 'the extracted body must write the sibling registry');
        assert.ok(COMPILE_SRC.indexOf('gina.forms.validators') < 0, 'the compile step must never touch the source registry (#M21c)');
    });
});


describe('02 — the shipped compileUserValidator under jsdom (#M21d)', function () {

    it('02.1 compiles a prologue-spliced source into gina.forms.compiledValidators and returns it', function () {
        var p = page();
        var fn = p.compile('sirenLike', SIREN_LIKE);
        assert.equal(typeof fn, 'function');
        assert.equal(p.gina.forms.compiledValidators.sirenLike, fn);
        assert.equal(p.errors.length, 0, 'no script error reported: ' + p.errors.join(' | '));
    });

    it('02.2 the compiled function sees the scope contract through this.getValidationContext() and validates', function () {
        var p = page();
        var fn = p.compile('sirenLike', SIREN_LIKE);
        var good = fieldCtx('552 081 317', true);
        assert.equal(fn.call(good, 'bad siren'), true);
        assert.equal(good.local.errorLabels.sirenLike, undefined, 'a valid value writes no label');
        var bad = fieldCtx('12', true);
        assert.equal(fn.call(bad, 'bad siren'), false);
        assert.equal(bad.local.errorLabels.sirenLike, 'bad siren', 'the body reached `local` from the prologue');
    });

    it('02.3 compiles once per page: a second call for the same name returns the same function', function () {
        var p = page();
        var a = p.compile('sirenLike', SIREN_LIKE);
        var b = p.compile('sirenLike', 'function NEVER_COMPILED() { throw new Error("recompiled"); }');
        assert.equal(a, b);
        assert.equal(p.doc.querySelectorAll('script').length, 0, 'the compile script is removed after it ran');
    });

    it('02.4 copies the page nonce onto the compile script when a nonced script exists', function () {
        var p = page({ nonce: 'n0nc3' });
        var seen = [];
        var origAppend = p.doc.head.appendChild.bind(p.doc.head);
        p.doc.head.appendChild = function (node) {
            if (node.tagName === 'SCRIPT') { seen.push(node.getAttribute('nonce')); }
            return origAppend(node);
        };
        p.compile('sirenLike', SIREN_LIKE);
        assert.deepEqual(seen, ['n0nc3']);
        assert.equal(p.doc.querySelectorAll('script').length, 1, 'only the page\'s own nonced script remains');
    });

    it('02.5 sets no nonce when the page has none', function () {
        var p = page();
        var seen = [];
        var origAppend = p.doc.head.appendChild.bind(p.doc.head);
        p.doc.head.appendChild = function (node) {
            if (node.tagName === 'SCRIPT') { seen.push(node.hasAttribute('nonce')); }
            return origAppend(node);
        };
        p.compile('sirenLike', SIREN_LIKE);
        assert.deepEqual(seen, [false]);
    });

    it('02.6 a source the browser cannot compile is refused with the documented message, nothing registered', function () {
        var p = page();
        assert.throws(function () { p.compile('broken', 'function ( {'); },
            /the browser did not compile it — look for a SyntaxError or a Content-Security-Policy report in the console/);
        assert.equal(p.gina.forms.compiledValidators.broken, undefined);
        assert.equal(p.doc.querySelectorAll('script').length, 0, 'the failed script is removed too');
        assert.ok(p.errors.some(function (e) { return /SyntaxError/.test(e); }), 'the browser reported the SyntaxError on the console');
    });
});


describe('03 — the real engine on the server (#M21d)', function () {

    var registered = function myRule(errorMessage) { this.valid = true; return this.valid; };

    function seed(validators) {
        setContext('gina', { forms: { validators: validators } });
        // Harness affordance (as validator-label-alias.test.js): the engine's user-validator
        // block reads the bare client global; seed the server equivalent so the block runs.
        global.gina = getContext('gina');
    }
    function teardown() {
        delete global.gina;
        setContext('gina', {});
    }
    after(teardown);

    it('03.1 a function registered on the context is attached by IDENTITY (the retired round trip produced a copy)', function () {
        seed({ myRule: registered });
        var FormValidator = require(ENGINE_PATH);
        var val = new FormValidator({ f: 'x' });
        assert.equal(val.f.myRule, registered);
        assert.equal(typeof val.f.getValidationContext, 'function', 'the engine constructed normally');
    });

    it('03.2 a source-shaped registration (the disk-loaded Buffer shape) is refused naming the browser-only contract', function () {
        seed({ fromDisk: { data: Buffer.from('function FormValidateFromDisk(e) { this.valid = true; }') } });
        var FormValidator = require(ENGINE_PATH);
        assert.throws(function () { new FormValidator({ f: 'x' }); }, function (err) {
            return /\[UserFormValidator\] Could not evaluate: `\/validators\/fromDisk\/main\.js`/.test(err.message) &&
                   /custom validators run in the browser only/.test(err.message);
        });
    });
});
