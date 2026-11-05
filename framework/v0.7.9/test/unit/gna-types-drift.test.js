'use strict';

/**
 * Drift-detection test for types/gna.d.ts (#M9).
 *
 * Regenerates the type declaration in memory via
 * `script/generate_gna_types.js` and compares the result to the checked-in
 * file. Any mismatch means a global export was added/removed (or its JSDoc
 * changed) without re-running `npm run types:gen`.
 *
 * Run with:
 *   node --test framework/v*\/test/unit/gna-types-drift.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');

const REPO_ROOT  = path.resolve(__dirname, '../../../..');
const GENERATOR  = path.join(REPO_ROOT, 'script', 'generate_gna_types.js');
const DECL_FILE  = path.join(REPO_ROOT, 'types', 'gna.d.ts');

test('types/gna.d.ts is in sync with the generator', () => {
    const { generate } = require(GENERATOR);
    const expected     = generate();
    const actual       = fs.readFileSync(DECL_FILE, 'utf8');

    if (expected !== actual) {
        // Build a tiny diff hint pointing at the first mismatched line so the
        // failure message is actionable without needing `diff`.
        const expLines = expected.split('\n');
        const actLines = actual.split('\n');
        const limit    = Math.max(expLines.length, actLines.length);
        let firstDiff  = -1;
        for (let i = 0; i < limit; i++) {
            if (expLines[i] !== actLines[i]) { firstDiff = i + 1; break; }
        }
        const msg =
            'types/gna.d.ts drifted from generator output. ' +
            'Run `npm run types:gen` to regenerate.' +
            (firstDiff > 0
                ? '\n  First diff at line ' + firstDiff +
                  '\n  expected: ' + JSON.stringify(expLines[firstDiff - 1]) +
                  '\n  actual:   ' + JSON.stringify(actLines[firstDiff - 1])
                : '');
        assert.fail(msg);
    }
});
