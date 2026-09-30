/**
 * lib/cmd/bundle/start.js — Bun-safety of the node_modules reinstall on bundle:start.
 *
 * `checkArchAgainstNodeModules` (reached on every `gina bundle:start`) reinstalls
 * the project's node_modules when a local-scope arch/platform mismatch is detected.
 * It shelled out two ways that a Bun-only image (no node, no npm) cannot satisfy:
 *
 *   1. `var npmCmd = isWin32() ? 'npm.cmd install' : 'npm install'` — a Bun-only
 *      image ships no `npm` binary, so `execSync(npmCmd)` ENOENTs.
 *   2. `execSync(ginaBin + ' framework:link @<proj>')` — `ginaBin` (`which gina`)
 *      is a `#!/usr/bin/env node` script, so executing it directly in a no-node
 *      image fails on the shebang.
 *
 * The fix gated both on `runtime.isBun()`:
 *   - npmCmd  → `'bun install'` under Bun (else the original npm command) — ZERO
 *     Node delta by construction: `runtime.isBun()` is false on Node.
 *   - the link step → ran the gina bin under `runtime.runtimeBinary()` (the running
 *     Bun binary), bypassing the node shebang.
 *
 * #B665 then replaced the link step's command line: it runs this install's own
 * `bin/gina` (resolved from the file — no `which gina`) as
 * `execFileSync(runtime.runtimeBinary(process.execPath), [ginaBin,
 * 'framework:link', '@' + project])`, without a shell. Under Bun that is the
 * running Bun binary, as before; under Node it is the running node, where the
 * shebang's PATH node ran it before — so the link step is no longer
 * byte-identical on Node.
 *
 * Tests are two-layered:
 *   (a) source-inspection — npmCmd is gated on `runtime.isBun()`, the link step
 *       runs under `runtimeBinary(process.execPath)` from an argument vector, and
 *       the old bare forms are gone. This is the PRIMARY guard: the no-node/no-npm
 *       break is Bun-specific and cannot be reproduced on Node, which runs this
 *       suite.
 *   (b) behaviour — a pure-logic replica of the npmCmd ternary (Node
 *       byte-identical to the pre-fix strings, `bun install` under Bun) and of the
 *       link step's executable and arguments (the running node under Node, the Bun
 *       binary under Bun, the same arguments), with a subtract.
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');

var FW    = require('../fw');
var START = path.join(FW, 'lib/cmd/bundle/start.js');


// ---------------------------------------------------------------------------
// 01 — source: the reinstall commands are Bun-aware (runtime.isBun()-gated)
// ---------------------------------------------------------------------------
describe('01 - bundle:start reinstall is PM/runtime aware for Bun', function() {

    var code;
    before(function() {
        // Strip line comments so the explanatory Bun comments (which mention the
        // old `npm install` / `ginaBin` forms) cannot trip the negative pins.
        code = fs.readFileSync(START, 'utf8').replace(/\/\/[^\n]*/g, '');
    });

    it('requires utils/runtime by relative path', function() {
        assert.match(code, /var runtime\s*=\s*require\([^)]*utils\/runtime/,
            'start.js must require utils/runtime.js for isBun()/runtimeBinary()');
    });

    it('npmCmd is gated on runtime.isBun() and uses `bun install` under Bun', function() {
        assert.match(code, /var npmCmd\s*=\s*runtime\.isBun\(\)/,
            'npmCmd must be gated on runtime.isBun()');
        assert.match(code, /\?\s*'bun install'/,
            'the Bun branch of npmCmd must be `bun install`');
    });

    it('the old bare `var npmCmd = ( isWin32() ) ? ...` assignment is gone', function() {
        assert.doesNotMatch(code, /var npmCmd\s*=\s*\(\s*isWin32/,
            'npmCmd must no longer start with the unguarded isWin32() ternary');
    });

    it('framework:link runs this install\'s bin/gina under runtimeBinary(process.execPath), from an argument vector (#B665)', function() {
        assert.match(code, /var ginaBin\s*=\s*require\('path'\)\.resolve\(__dirname,\s*'\.\.\/\.\.\/\.\.\/\.\.\/\.\.'\s*,\s*'bin\/gina'\)/,
            'the gina bin must be this install\'s own, resolved from start.js\'s location');
        assert.doesNotMatch(code, /which gina/,
            'the gina bin must no longer be looked up on PATH');
        assert.match(code, /execFileSync\(\s*runtime\.runtimeBinary\(\s*process\.execPath\s*\)\s*,\s*\[\s*ginaBin\s*,\s*'framework:link'\s*,\s*'@'\s*\+\s*self\.projectName\s*\]\s*\)/,
            'the self-invoke must run under the runtime binary, each value its own argument');
    });

    it('the old direct `execSync(ginaBin + ...)` self-invoke is gone', function() {
        assert.doesNotMatch(code, /execSync\(\s*ginaBin\s*\+/,
            'the gina bin must no longer be exec\'d directly (shebang fails in a no-node image)');
    });

});


// ---------------------------------------------------------------------------
// 02 — behaviour: pure-logic replica of the two ternaries (Node parity + Bun)
// ---------------------------------------------------------------------------
describe('02 - bundle:start reinstall command shape (replica)', function() {

    // Mirror of start.js exactly.
    function pickNpmCmd(isBun, isWin32) {
        return isBun
            ? 'bun install'
            : ( isWin32 ? 'npm.cmd install' : 'npm install' );
    }
    // #B665 — the link step's executable and arguments: runtime.runtimeBinary(process.execPath)
    // is the running Bun binary under Bun (process.execPath there) and process.execPath
    // (the running node) under Node.
    function pickLinkCall(isBun, bunBinary, nodeBinary, ginaBin, projectName) {
        return {
            file: isBun ? bunBinary : nodeBinary,
            args: [ginaBin, 'framework:link', '@' + projectName]
        };
    }

    var GINA_BIN = '/usr/local/lib/node_modules/gina/bin/gina';
    var PROJ     = 'myproject';
    var BUN_BIN  = '/home/u/.bun/bin/bun';
    var NODE_BIN = '/usr/local/bin/node';

    it('Node (non-win32): npm install byte-identical to the pre-fix string; the link runs under the running node', function() {
        assert.strictEqual(pickNpmCmd(false, false), 'npm install');
        assert.deepStrictEqual(
            pickLinkCall(false, BUN_BIN, NODE_BIN, GINA_BIN, PROJ),
            { file: NODE_BIN, args: [GINA_BIN, 'framework:link', '@' + PROJ] });
    });

    it('Node (win32): byte-identical to the pre-fix npm.cmd string', function() {
        assert.strictEqual(pickNpmCmd(false, true), 'npm.cmd install');
    });

    it('Bun: npmCmd is `bun install` and the link runs under the bun binary', function() {
        assert.strictEqual(pickNpmCmd(true, false), 'bun install');
        assert.strictEqual(pickNpmCmd(true, true), 'bun install'); // win32 irrelevant under Bun
        assert.deepStrictEqual(
            pickLinkCall(true, BUN_BIN, NODE_BIN, GINA_BIN, PROJ),
            { file: BUN_BIN, args: [GINA_BIN, 'framework:link', '@' + PROJ] });
    });

    it('subtract: under Bun the npm command and the link executable differ from Node; the link arguments do not', function() {
        assert.notStrictEqual(pickNpmCmd(true, false), pickNpmCmd(false, false));
        var bun  = pickLinkCall(true, BUN_BIN, NODE_BIN, GINA_BIN, PROJ);
        var node = pickLinkCall(false, BUN_BIN, NODE_BIN, GINA_BIN, PROJ);
        assert.notStrictEqual(bun.file, node.file);
        assert.deepStrictEqual(bun.args, node.args);
    });

});
