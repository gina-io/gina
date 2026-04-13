#!/usr/bin/env node

/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Pre-pack leak check.
 *
 * Runs as the `prepack` npm lifecycle hook. Before the tarball is assembled,
 * this script re-runs `npm pack --dry-run --json --ignore-scripts` and fails
 * the publish if any path in the pack listing matches a Claude-related name
 * (`CLAUDE.md`, `.claude*`).
 *
 * `--ignore-scripts` prevents recursion into the `prepare` script (which would
 * otherwise re-invoke `prepare_version.js` and commit a "Prerelease update").
 *
 * Exit codes:
 *   0  — pack listing is clean
 *   1  — Claude-related path detected OR check itself errored (fail closed)
 */

var execSync = require('child_process').execSync;

var PATTERN = /(^|\/)(CLAUDE\.md|\.claude[a-z]*)/i;

try {
    var raw = execSync('npm pack --dry-run --json --ignore-scripts', {
        stdio: ['ignore', 'pipe', 'pipe']
    }).toString();

    var parsed = JSON.parse(raw);
    var matches = [];

    for (var i = 0; i < parsed.length; i++) {
        var files = parsed[i].files || [];
        for (var j = 0; j < files.length; j++) {
            if (PATTERN.test(files[j].path)) {
                matches.push(files[j].path);
            }
        }
    }

    if (matches.length > 0) {
        console.error('[prepack] ERROR: Claude-related files detected in pack listing:');
        for (var k = 0; k < matches.length; k++) {
            console.error('  - ' + matches[k]);
        }
        console.error('[prepack] Fix .npmignore (or package.json "files") before publishing.');
        process.exit(1);
    }

    console.log('[prepack] OK: pack listing contains no Claude-related paths.');
    process.exit(0);
} catch (err) {
    console.error('[prepack] Check failed: ' + (err.message || err));
    console.error('[prepack] Failing closed — investigate before publishing.');
    process.exit(1);
}
