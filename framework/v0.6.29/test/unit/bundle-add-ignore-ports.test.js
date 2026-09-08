'use strict';

/**
 * Unit tests for the `--ignore-ports` flag on `gina bundle:add`.
 *
 * Run with:
 *   node --test framework/v*\/test/unit/bundle-add-ignore-ports.test.js
 *
 * Two layers (the established gina idiom):
 *   (1) source-inspection pins — lock the parse branch + scan-ignore merge in
 *       lib/cmd/bundle/add.js and the arguments.json whitelist entry, so the
 *       pure-logic replica below cannot silently drift from the shipped code.
 *   (2) pure-logic replica — mirror the CSV parse/validate/merge and assert
 *       behaviour (valid -> string list, whitespace tolerated, empty tokens
 *       skipped, dedup, invalid -> error, merge dedups against the
 *       already-assigned ports).
 *
 * add.js is not required directly — it pulls in CmdHelper / lib.logger / a live
 * project context. The flag's logic is small and self-contained, so source pins
 * + a replica give honest coverage without booting the CLI.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');

const ADD_SRC = fs.readFileSync(
    path.resolve(__dirname, '../../lib/cmd/bundle/add.js'), 'utf8'
);
const ARGS = require(
    path.resolve(__dirname, '../../lib/cmd/bundle/arguments.json')
);

// ---------------------------------------------------------------------------
// (1) Source-inspection pins
// ---------------------------------------------------------------------------

test('arguments.json whitelists --ignore-ports', () => {
    assert.ok(
        ARGS.indexOf('--ignore-ports') > -1,
        '--ignore-ports must be whitelisted so getParams() routes it to cmd.params, not cmd.nodeParams'
    );
});

test('add.js declares the ignorePorts state default', () => {
    assert.match(
        ADD_SRC, /ignorePorts\s*:\s*\[\]/,
        'self.ignorePorts must default to an empty array'
    );
});

test('add.js parses the --ignore-ports flag from argv', () => {
    // the init() loop matches each argv token against /^\-\-ignore\-ports\=/
    assert.ok(
        ADD_SRC.indexOf('ignore\\-ports\\=') > -1,
        'init() must test argv tokens against the /^\\-\\-ignore\\-ports\\=/ regex'
    );
});

test('add.js validates ignore entries as integers and keeps them as strings', () => {
    // integer-shape validation, mirroring the sibling --start-port-from check
    assert.match(
        ADD_SRC, /must be a comma-separated list of integers/,
        'invalid (non-integer) entries must error'
    );
    // pushed verbatim (string token), NOT parseInt-coerced — scan.js compares ''+port
    assert.match(
        ADD_SRC, /self\.ignorePorts\.push\(\s*p\s*\)/,
        'parsed tokens are pushed as strings, not parseInt-coerced'
    );
});

test('add.js merges ignorePorts into the scan ignore list', () => {
    assert.match(
        ADD_SRC, /ignoreList\.push\(\s*self\.ignorePorts\[ig\]\s*\)/,
        'self.ignorePorts must be unioned into the scan ignore list'
    );
    assert.match(
        ADD_SRC, /ignore\s*:\s*ignoreList/,
        'scan options.ignore must be the merged list'
    );
});

// ---------------------------------------------------------------------------
// (2) Pure-logic replica of the add.js parse/validate/merge
//     Kept in lockstep with the source by the pins above.
// ---------------------------------------------------------------------------

/** Mirror of the --ignore-ports branch in lib/cmd/bundle/add.js init(). */
function parseIgnorePorts(rawValue) {
    var out     = [];
    var entries = String(rawValue).split(/,/);
    for (var e = 0; e < entries.length; e++) {
        var p = entries[e].trim();
        if (p === '') { continue; }                 // tolerate empty tokens
        if (/[^0-9]+/.test(p)) {
            throw new Error('--ignore-ports must be a comma-separated list of integers');
        }
        if (out.indexOf(p) < 0) { out.push(p); }    // dedup
    }
    return out;
}

/** Mirror of the scan-options ignore merge in addBundles(). */
function mergeIgnore(assigned, extra) {
    var list = assigned.slice();
    for (var i = 0; i < extra.length; i++) {
        if (list.indexOf(extra[i]) < 0) { list.push(extra[i]); }
    }
    return list;
}

test('parses a simple comma-separated list into string ports', () => {
    const out = parseIgnorePorts('3000,3001,8080');
    assert.deepEqual(out, ['3000', '3001', '8080']);
    for (const p of out) { assert.equal(typeof p, 'string'); }
});

test('tolerates surrounding whitespace per entry', () => {
    assert.deepEqual(parseIgnorePorts('3000, 3001 ,  8080'), ['3000', '3001', '8080']);
});

test('skips empty tokens from trailing / duplicate commas', () => {
    assert.deepEqual(parseIgnorePorts('3000,,3001,'), ['3000', '3001']);
    assert.deepEqual(parseIgnorePorts(''), []);
});

test('de-duplicates repeated ports', () => {
    assert.deepEqual(parseIgnorePorts('3000,3000,3001'), ['3000', '3001']);
});

test('rejects non-integer entries', () => {
    assert.throws(() => parseIgnorePorts('30a0'),    /comma-separated list of integers/);
    assert.throws(() => parseIgnorePorts('3000,8x'), /comma-separated list of integers/);
    assert.throws(() => parseIgnorePorts('3000,-1'), /comma-separated list of integers/);
});

test('merge unions extra ports with the already-assigned list and dedups', () => {
    // assigned (getPortsList() output) and extra (parsed) are both strings
    const assigned = ['3100', '3101'];
    const merged   = mergeIgnore(assigned, parseIgnorePorts('3101,3000'));
    assert.deepEqual(merged, ['3100', '3101', '3000']);
    // the assigned array is not mutated
    assert.deepEqual(assigned, ['3100', '3101']);
});
