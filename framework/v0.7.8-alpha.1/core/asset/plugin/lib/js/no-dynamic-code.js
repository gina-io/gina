#!/usr/bin/env node
/**
 * no-dynamic-code — build-time step for the browser bundle (#M21d).
 *
 * Two vendored libraries the bundle inlines carry a dynamic-code call the framework
 * never reaches, and each one keeps a supply-chain scanner's "Uses eval" verdict on
 * every published version:
 *
 *   1. RequireJS `req.exec` (`require.js`, the `load.fromText` transpiler-plugin API):
 *      nothing in the bundle calls `fromText`, so the function is unreachable. Its body
 *      becomes a throw that names the reason.
 *   2. engine.io-client's global-object shim, `Function("return this")()`: the last
 *      fallback after `self` and `window`, both of which exist in every browser, so it
 *      never runs. It becomes `globalThis`.
 *
 * `patch <file>` rewrites the r.js output in place. Each replacement is EXACT-MATCH and
 * must occur exactly once: a dependency bump that moves the text fails the build here,
 * loudly, instead of silently re-shipping the call.
 *
 * `assert <file>...` fails when any live `eval(` / `Function(` call remains in the given
 * files (comments stripped), and — the control — when a file contains no code at all.
 * It runs on the r.js output and again on the Closure output.
 *
 * Not shipped: `core/asset/plugin/lib` is excluded from the npm tarball, which is also
 * why the needles below may name the calls they remove.
 */
'use strict';

var fs = require('fs');

var PATCHES = [
    {
        name: 'requirejs req.exec',
        from: "    req.exec = function (text) {\n        /*jslint evil: true */\n        return eval(text);\n    };\n",
        to:   "    req.exec = function (text) {\n        throw new Error('require.exec() is disabled in this build: gina ships no transpiler loader plugins');\n    };\n"
    },
    {
        name: 'engine.io-client global-object shim',
        from: ':Function("return this")()',
        to:   ':globalThis'
    }
];

var LIVE_CALL = /(^|[^\w.$])(eval|Function)\s*\(/;

/**
 * Removes block and line comments so a call counted afterwards is a real one.
 * Coarse on purpose: a `//` inside a string literal loses the rest of that line,
 * which can only UNDER-count — never manufacture — a call.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function fail(msg) {
    process.stderr.write('[no-dynamic-code] ' + msg + '\n');
    process.exit(1);
}

function patch(file) {
    var src = fs.readFileSync(file, 'utf8');
    PATCHES.forEach(function (p) {
        var n = src.split(p.from).length - 1;
        if (n !== 1) {
            fail(p.name + ': expected the upstream text exactly once in ' + file + ', found ' + n +
                 ' — the vendored dependency changed; update the needle in ' + __filename);
        }
        src = src.replace(p.from, p.to);
    });
    fs.writeFileSync(file, src);
    process.stdout.write('[no-dynamic-code] patched ' + PATCHES.length + ' site(s) in ' + file + '\n');
}

function assert(files) {
    files.forEach(function (file) {
        var code = stripComments(fs.readFileSync(file, 'utf8'));
        if (!/\S/.test(code)) {
            fail(file + ' contains no code after comment stripping — nothing to check');
        }
        var m = LIVE_CALL.exec(code);
        if (m) {
            var at = code.indexOf(m[0]);
            fail(file + ' still contains a live ' + m[2] + '( call near: ' +
                 JSON.stringify(code.slice(Math.max(0, at - 60), at + 40)));
        }
        process.stdout.write('[no-dynamic-code] clean: ' + file + '\n');
    });
}

var mode = process.argv[2];
var args = process.argv.slice(3);
if (mode === 'patch' && args.length === 1) {
    patch(args[0]);
} else if (mode === 'assert' && args.length >= 1) {
    assert(args);
} else {
    fail('usage: no-dynamic-code.js patch <file> | assert <file>...');
}
