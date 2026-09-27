/**
 * bin/gina — Bun-safety guard on the NODE_PROJECT `.replace`.
 *
 * Under Node, assigning an absent process.argv slot to an env var coerces it to
 * the string 'undefined', so `process.env.NODE_PROJECT.replace(...)` works for
 * argless commands (e.g. `gina version`). Under Bun the assignment stays real
 * undefined and the `.replace` throws — crashing the CLI on its first command.
 *
 * Stage 1 guards the call with `typeof process.env.NODE_PROJECT === 'string'`,
 * which is always true on Node (so behaviour is unchanged) and false on Bun for
 * an absent arg (so the crash is avoided). These tests are two-layered:
 *   (a) source-inspection — the guard is present and precedes the .replace;
 *   (b) behaviour — a pure-logic replica of the guarded block proves the present
 *       arg still strips `@` and the absent (real-undefined) arg does not throw.
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var GINA_SOURCE = path.resolve(__dirname, '..', '..', 'bin', 'gina');
var ginaSrc     = fs.readFileSync(GINA_SOURCE, 'utf8');


// ---------------------------------------------------------------------------
// 01 — source: the .replace is guarded by a typeof === 'string' check
// ---------------------------------------------------------------------------
describe('01 - bin/gina: NODE_PROJECT .replace is Bun-guarded', function() {

    it('guards the .replace with a typeof process.env.NODE_PROJECT === string check', function() {
        assert.match(
            ginaSrc,
            /typeof\s+process\.env\.NODE_PROJECT\s*===\s*'string'/,
            'expected a typeof === string guard before the NODE_PROJECT .replace'
        );
    });

    it('the guard precedes the NODE_PROJECT .replace call', function() {
        var guardIdx   = ginaSrc.indexOf("typeof process.env.NODE_PROJECT === 'string'");
        var replaceIdx = ginaSrc.indexOf('process.env.NODE_PROJECT.replace');
        assert.ok(guardIdx > -1, 'guard not found in bin/gina');
        assert.ok(replaceIdx > -1, 'NODE_PROJECT .replace not found in bin/gina');
        assert.ok(guardIdx < replaceIdx, 'guard must come before the .replace');
    });

});


// ---------------------------------------------------------------------------
// 02 — behaviour: pure-logic replica of the guarded block
// ---------------------------------------------------------------------------
describe('02 - bin/gina: NODE_PROJECT normalisation replica', function() {

    // Mirrors the guarded block. `raw` stands in for process.env.NODE_PROJECT
    // after the env-assignment from process.argv[4]: a string on Node (incl. the
    // literal 'undefined' when the arg is absent) and real undefined on Bun for
    // an absent arg.
    var normalise = function(raw) {
        var val = raw;
        if ( typeof val === 'string' ) {
            val = val.replace(/\@/, '');
        }
        return val;
    };

    it('strips a leading @ from a present project arg', function() {
        assert.equal(normalise('@myproject'), 'myproject');
    });

    it('leaves the Node absent-arg string undefined a string (behaviour unchanged)', function() {
        assert.equal(normalise('undefined'), 'undefined');
    });

    it('does not throw on a real undefined (the Bun absent-arg case)', function() {
        assert.doesNotThrow(function() { normalise(undefined); });
        assert.equal(normalise(undefined), undefined);
    });

});


// ---------------------------------------------------------------------------
// 03 — source: the daemon-spawn binary is runtime-aware (Bun Stage 4)
//
// runAsSubProcess() historically resolved `which node`, which a no-node Bun
// image cannot satisfy. The binary is now routed through utils/runtime's
// runtimeBinary(), with `which node` evaluated ONLY under Node (isBun() false),
// so the Node path is byte-identical and the Bun path spawns the Bun binary.
// ---------------------------------------------------------------------------
describe('03 - bin/gina: daemon-spawn binary is runtime-aware', function() {

    it('requires the utils/runtime helper', function() {
        assert.match(ginaSrc, /require\(__dirname \+ '\/\.\.\/utils\/runtime\.js'\)/);
    });

    it('gates `which node` behind runtime.isBun() and routes through runtimeBinary()', function() {
        assert.match(
            ginaSrc,
            /runtime\.isBun\(\)\s*\?\s*runtime\.runtimeBinary\(\)\s*:\s*runtime\.runtimeBinary\(execSync\('which node'\)/,
            'expected nodeBin = isBun() ? runtimeBinary() : runtimeBinary(execSync(which node)...)'
        );
    });

    it('still spawns the resolved binary (nodeBin)', function() {
        assert.match(ginaSrc, /spawn\(nodeBin, argv/);
    });

});


// ---------------------------------------------------------------------------
// 04 — source: the NODE_ARGV env write is Bun-safe (String-coerced) + the
//      catch handler uses console.error (Bun Stage 4 — daemonful bundle:start)
//
// `process.env.NODE_ARGV = process.argv.slice()` assigns an ARRAY. Node coerces
// it to a comma-joined string; Bun leaves it a real array (object), so the
// writeFileSync below throws and the catch fires — where `console.emerg`
// (undefined in bin/gina's global-console scope on EITHER runtime) crashed the
// CLI before bundle:start could reach the daemon. The fix String()-coerces the
// array (byte-identical to Node's comma-join, matching getBundleStartingArgv's
// comma->space read) and uses console.error in the catch.
// ---------------------------------------------------------------------------
describe('04 - bin/gina: NODE_ARGV env write is Bun-safe', function() {

    it('String()-coerces the argv array before assigning NODE_ARGV', function() {
        assert.match(
            ginaSrc,
            /process\.env\.NODE_ARGV\s*=\s*String\(process\.argv\.slice\(\)\)/,
            'expected process.env.NODE_ARGV = String(process.argv.slice())'
        );
    });

    it('does NOT assign the bare (non-coerced) array — the Bun break', function() {
        assert.doesNotMatch(
            ginaSrc,
            /process\.env\.NODE_ARGV\s*=\s*process\.argv\.slice\(\)\s*;/,
            'NODE_ARGV must not be the bare array (Bun keeps it an object -> writeFileSync throws)'
        );
    });

    it('the .argv writeFileSync catch uses console.error, not the undefined console.emerg', function() {
        var writeIdx = ginaSrc.indexOf('fs.writeFileSync(argFilename');
        assert.ok(writeIdx > -1, 'argv writeFileSync not found');
        var block = ginaSrc.slice(writeIdx, writeIdx + 400);
        assert.match(block, /catch\s*\(err\)\s*\{[\s\S]*console\.error\(err\)/,
            'expected console.error(err) in the writeFileSync catch');
        assert.doesNotMatch(block, /console\.emerg\(err\)/,
            'console.emerg is undefined in bin/gina (global console) — must not be used');
    });

});


// ---------------------------------------------------------------------------
// 07 — #B676: the saved start argv is written to the user-owned argv dir (`getArgvDir()` =
// `<GINA_HOMEDIR>/run`) with mode 0600, never to the shared tmp dir: `gina tail --follow`
// executes that file's first token, and a tmp dir another host user can write let them plant
// or pre-own it. Pins are read on the argv branch only (from the helper require to the
// `require(cliBin)` hand-off), comment-stripped for the negative so the `// was:` record of
// the old `getTmpDir()` line cannot satisfy or defeat it; the raw slice keeps that record as
// the anti-vacuity control. Red-first: 07.1-07.3 fail on the pre-#B676 bytes, 07.4 is a
// control that is green on both.
describe('07 - bin/gina: the .argv file lives in the argv dir, mode 0600 (#B676)', function() {

    var startIdx = ginaSrc.indexOf("var help        = require(__dirname + '/../utils/helper.js');");
    var endIdx   = ginaSrc.indexOf('require(cliBin);', startIdx);
    var rawBlock = (startIdx > -1 && endIdx > startIdx) ? ginaSrc.slice(startIdx, endIdx) : '';
    var codeBlock = rawBlock.split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');

    it('slices the argv branch (both anchors present, in order)', function() {
        assert.ok(startIdx > -1, 'helper require anchor not found');
        assert.ok(endIdx > startIdx, 'require(cliBin) anchor not found after the helper require');
    });

    it('07.1 resolves the file under getArgvDir()', function() {
        assert.match(codeBlock, /var argvDir\s*=\s*getArgvDir\(\);/, 'expected var argvDir = getArgvDir();');
        assert.match(codeBlock, /var argFilename\s*=\s*argvDir\s*\+/, 'argFilename must be built from argvDir');
    });

    it('07.2 no longer resolves it under getTmpDir() (comment-stripped)', function() {
        assert.ok(codeBlock.indexOf('getTmpDir()') < 0, 'getTmpDir() must not be called on the argv branch');
    });

    it('07.3 writes the file with mode 0600', function() {
        assert.match(codeBlock, /fs\.writeFileSync\(argFilename,\s*process\.env\.NODE_ARGV,\s*\{\s*mode:\s*0o600\s*\}\)/,
            'expected fs.writeFileSync(argFilename, process.env.NODE_ARGV, { mode: 0o600 })');
    });

    it('07.4 CONTROL - the raw branch still names getTmpDir (the comment strip is what makes 07.2 meaningful)', function() {
        assert.ok(rawBlock.indexOf('getTmpDir') > -1, 'the raw slice must still carry the getTmpDir record');
    });
});


// ---------------------------------------------------------------------------
// 05 — behaviour: the array->string coercion the .argv persistence relies on,
//      and its round-trip through getBundleStartingArgv's comma->space read.
// ---------------------------------------------------------------------------
describe('05 - bin/gina: NODE_ARGV array coercion replica', function() {

    // mirrors bin/gina:216 — coerce the argv array for the .argv file
    var coerce   = function(argvArray) { return String(argvArray); };          // FIXED
    // mirrors getBundleStartingArgv (utils/helper.js): read file, comma->space
    var readBack = function(onDisk)     { return ('' + onDisk).replace(/\,/g, ' '); };

    var sampleArgv = ['/path/to/bun', '/path/bin/gina', 'bundle:start', 'api', '@proj'];

    it('coerces the argv array to a comma-joined string (Node-identical)', function() {
        var s = coerce(sampleArgv);
        assert.strictEqual(typeof s, 'string');
        assert.strictEqual(s, '/path/to/bun,/path/bin/gina,bundle:start,api,@proj');
    });

    it('round-trips through the comma->space reader to the exact restart argv', function() {
        var onDisk      = coerce(sampleArgv);                                   // comma-joined on disk
        var restored    = readBack(onDisk);                                     // getBundleStartingArgv comma->space
        var restartArgv = restored.split(/\s+/).filter(function (a) { return a !== ''; });
        assert.deepEqual(restartArgv, sampleArgv);
        assert.ok(restartArgv.indexOf('bundle:start') > -1);
    });

    it('subtract: the bare array (Bun non-coerced) is not writable + has no .replace', function() {
        // Under Bun, process.env.NODE_ARGV = array leaves it an array (typeof object).
        assert.strictEqual(typeof sampleArgv, 'object');
        var writable = (typeof sampleArgv === 'string') || Buffer.isBuffer(sampleArgv);
        assert.strictEqual(writable, false, 'writeFileSync(file, array) throws — data must be string/Buffer');
        // the bundle:restart path does NODE_ARGV.replace(...) — arrays have no .replace.
        assert.strictEqual(typeof sampleArgv.replace, 'undefined');
    });

});
