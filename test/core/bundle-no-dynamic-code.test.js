'use strict';
/**
 * #M21d — the built browser bundle ships no dynamic-code call.
 *
 * After the validator engine's own `eval` left (test/lib/validator-m21d.test.js), two
 * vendored libraries the r.js build inlines still carried one each: RequireJS `req.exec`
 * (`load.fromText`, the transpiler-plugin API — nothing in the bundle calls it) and
 * engine.io-client's global-object shim `Function("return this")()` (the fallback after
 * `self` and `window`, which every browser defines). A supply-chain scanner flags
 * `Function()` exactly like `eval()`, so both had to go for the "Uses eval" verdict to
 * stop flipping the package score on identical bytes.
 *
 * `core/asset/plugin/lib/js/no-dynamic-code.js` rewrites both at build time by EXACT
 * match — a dependency bump that moves the text fails the build instead of silently
 * re-shipping the call — and asserts the r.js output and the Closure output clean.
 *
 * Shape: (a) dist pins — zero live `eval(` / `Function(` in gina.js AND gina.min.js
 * (comments stripped), with the controls that make a zero mean something (the raw gina.js
 * still names eval in RequireJS's comments; the replacement literals are present; the
 * files hold code); (b) the helper's contract, driven on fixtures in a temp dir (patch
 * applies once, refuses twice, assert fails on a live call and on a comment-only file,
 * passes on clean code, ignores `.eval(` / `myFunction(`); (c) the build script wires the
 * helper: patch + assert after r.js and before Closure, assert again after Closure.
 *
 * Red-first: (a) was run against the dist built BEFORE the change (2 live eval( + 1
 * Function( in each bundle) — every dist pin red, (b) and (c) green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var { spawnSync } = require('child_process');

var FW       = require('../fw');
var DIST_JS  = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var HELPER   = path.join(FW, 'core/asset/plugin/lib/js/no-dynamic-code.js');
var BUILD    = path.join(FW, 'core/asset/plugin/build');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}
var LIVE_CALL = /(^|[^\w.$])(eval|Function)\s*\(/;

function run(args) {
    var r = spawnSync(process.execPath, [HELPER].concat(args), { encoding: 'utf8' });
    return { rc: r.status, out: r.stdout + r.stderr };
}

// upstream texts as the r.js output carries them (the helper's own needles, restated here
// so a drift in either place is caught)
var REQ_EXEC   = "    req.exec = function (text) {\n        /*jslint evil: true */\n        return eval(text);\n    };\n";
var EIO_SHIM   = 'R="undefined"!=typeof self?self:"undefined"!=typeof window?window:Function("return this")()';


describe('01 — dist pins (#M21d)', function () {

    [['gina.js', DIST_JS], ['gina.min.js', DIST_MIN]].forEach(function (pair) {
        var name = pair[0], file = pair[1];

        it('01.1 ' + name + ' carries zero live eval( / Function( calls (comments stripped)', function () {
            var code = stripComments(fs.readFileSync(file, 'utf8'));
            assert.ok(/\S/.test(code), 'no code after stripping — the pin would pass vacuously');
            var m = LIVE_CALL.exec(code);
            assert.equal(m, null, name + ' still ships a live ' + (m && m[2]) + '( near: ' +
                (m ? JSON.stringify(code.slice(Math.max(0, m.index - 60), m.index + 40)) : ''));
        });

        it('01.2 ' + name + ' carries the two replacements (the exact-match rewrites landed)', function () {
            var src = fs.readFileSync(file, 'utf8');
            assert.ok(src.indexOf('require.exec() is disabled in this build') > -1, 'RequireJS req.exec replacement missing in ' + name);
            assert.ok(src.indexOf(':globalThis') > -1, 'engine.io shim replacement missing in ' + name);
            assert.equal(src.indexOf('Function("return this")()'), -1);
            assert.equal(src.indexOf("Function('return this')()"), -1);
        });
    });

    it('01.3 the raw gina.js still names eval in RequireJS\'s own comments (the strip is doing work — control)', function () {
        var raw = fs.readFileSync(DIST_JS, 'utf8');
        assert.ok(/Normally just uses eval/.test(raw), 'RequireJS header comment gone — re-check the 01.1 pin is not vacuous');
    });
});


describe('02 — the helper\'s contract on fixtures (#M21d)', function () {

    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm21d-'));
    function fixture(name, text) { var p = path.join(dir, name); fs.writeFileSync(p, text); return p; }

    it('02.1 patch: rewrites both upstream texts exactly once, then refuses a second run', function () {
        var f = fixture('bundle.js', 'var x = 1;\n' + REQ_EXEC + 'var ' + EIO_SHIM + ';\n');
        var first = run(['patch', f]);
        assert.equal(first.rc, 0, first.out);
        var after = fs.readFileSync(f, 'utf8');
        assert.ok(after.indexOf('require.exec() is disabled in this build') > -1);
        assert.ok(after.indexOf(':globalThis') > -1);
        assert.equal(LIVE_CALL.exec(stripComments(after)), null);
        var second = run(['patch', f]);
        assert.equal(second.rc, 1, 'a second patch must fail — the needle is gone');
        assert.match(second.out, /expected the upstream text exactly once/);
    });

    it('02.2 patch: refuses a file where a needle is missing (a dependency bump moved the text)', function () {
        var f = fixture('moved.js', 'var x = 1;\n' + REQ_EXEC);
        var r = run(['patch', f]);
        assert.equal(r.rc, 1);
        assert.match(r.out, /engine\.io-client global-object shim: expected the upstream text exactly once/);
    });

    it('02.3 assert: fails on a live eval( and on a live Function(, names the site', function () {
        var e = run(['assert', fixture('live-eval.js', 'var y = eval("1 + 1");\n')]);
        assert.equal(e.rc, 1); assert.match(e.out, /live eval\( call/);
        var f = run(['assert', fixture('live-fn.js', 'var g = Function("return this")();\n')]);
        assert.equal(f.rc, 1); assert.match(f.out, /live Function\( call/);
    });

    it('02.4 assert: a comment-only file fails (a strip that empties the file is not a pass — control)', function () {
        var r = run(['assert', fixture('comments.js', '// eval(1)\n/* Function(2) */\n')]);
        assert.equal(r.rc, 1);
        assert.match(r.out, /contains no code/);
    });

    it('02.5 assert: passes clean code, ignores .eval( / myFunction( / evaluate( and comments', function () {
        var r = run(['assert', fixture('clean.js', 'var a = x.eval(1); myFunction(2); evaluate(3); // eval( in a comment\nfunction f() { return a; }\n')]);
        assert.equal(r.rc, 0, r.out);
        assert.match(r.out, /clean:/);
    });

    it('02.6 usage: no mode or no file fails', function () {
        assert.equal(run([]).rc, 1);
        assert.equal(run(['assert']).rc, 1);
        assert.equal(run(['patch']).rc, 1);
    });
});


describe('03 — the build script wires the helper (#M21d)', function () {

    var build = fs.readFileSync(BUILD, 'utf8');

    it('03.1 patch + assert run on the r.js output, before Closure; assert runs again on the Closure output', function () {
        var patchIdx  = build.indexOf('no-dynamic-code.js patch "$rjs_out"');
        var assert1   = build.indexOf('no-dynamic-code.js assert "$rjs_out"');
        var closure   = build.indexOf('--compilation_level SIMPLE_OPTIMIZATIONS');
        var assertMin = build.indexOf('no-dynamic-code.js assert "$SCRIPT_PATH/dist/vendor/gina/js/gina.min.js"');
        assert.ok(patchIdx > -1 && assert1 > patchIdx, 'patch then assert on the r.js output');
        assert.ok(closure > assert1, 'the rewrite must precede the Closure phase, which minifies the patched gina.js');
        assert.ok(assertMin > closure, 'the Closure output is asserted clean too');
    });

    it('03.2 each helper call fails the build on error (|| exit 1)', function () {
        var calls = build.match(/node \$SCRIPT_PATH\/lib\/js\/no-dynamic-code\.js [^\n]*/g) || [];
        assert.equal(calls.length, 3);
        calls.forEach(function (c) { assert.match(c, /\|\| exit 1$/, c); });
    });

    it('03.3 the dev build patches its own r.js output path (gina.min.js, no Closure phase)', function () {
        assert.match(build, /if \[ "\$\{build_env\}" == "dev" \]; then\s*\n\s*rjs_out="\$SCRIPT_PATH\/dist\/vendor\/gina\/js\/gina\.min\.js"/);
    });
});
