#!/usr/bin/env node

/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @file script/retry_lockfile_sync.js
 *
 * Retry-with-backoff wrapper used by `script/post_publish.js → syncDocs`
 * to absorb the npm registry's eventual-consistency window after a stable
 * publish. Without this, intermittent
 * "package-lock.json: gina@<old> does not satisfy gina@<new>" failures
 * commit a stale lockfile alongside the bumped package.json, breaking the
 * next Vercel docs deploy.
 *
 * Background: the failure mode hit `gina@0.3.7` and `gina@0.3.9` stable
 * publishes (the second occurrence proved it was a recurring deterministic
 * ordering bug, not transient registry lag — see `llms.txt #126`, the release-pipeline
 * failure-modes entry that absorbed the former §87).
 *
 * Helpers exported via `module.exports` for unit testing with injected
 * `execDriver` / `sleepDriver` / `logger` — no real-repo or registry
 * fixtures needed.
 */

'use strict';

var execSync = require('child_process').execSync;


/**
 * Retry a shell command with backoff. Returns the first successful
 * invocation, or a failure result after all attempts are exhausted.
 *
 * @param {object}   opts
 * @param {string}   opts.cmd               shell command to run
 * @param {number[]} [opts.delaysSec]       one entry per attempt: the array's length is the attempt count, and entry i is slept after a failed attempt i — except the last entry, which is never slept (default [5, 15, 30, 30]: 4 attempts, ~50 s of sleep)
 * @param {function} [opts.execDriver]      injected execSync replacement (test-only)
 * @param {function} [opts.sleepDriver]     injected sleep(seconds) (test-only)
 * @param {object}   [opts.logger]          injected `{ info }` logger (test-only)
 * @returns {{ ok: boolean, attempts: number, lastErr: (Error|null) }}
 *
 * @example
 *   var retry = require('./retry_lockfile_sync');
 *   var result = retry.retryWithBackoff({
 *       cmd: '$(which npm) install --package-lock-only --ignore-scripts'
 *   });
 *   if (!result.ok) {
 *       console.warn('lockfile sync failed after ' + result.attempts + ' attempts');
 *   }
 */
function retryWithBackoff(opts) {
    opts = opts || {};
    if (!opts.cmd) throw new Error('retryWithBackoff: opts.cmd is required');
    var delays = opts.delaysSec || [5, 15, 30, 30];
    var exec   = opts.execDriver  || function (c) { return execSync(c, { stdio: 'pipe' }); };
    var sleep  = opts.sleepDriver || function (s) { execSync('sleep ' + s); };
    var log    = opts.logger      || console;

    var lastErr = null;
    var totalAttempts = delays.length;
    for (var i = 0; i < totalAttempts; i++) {
        try {
            exec(opts.cmd);
            return { ok: true, attempts: i + 1, lastErr: null };
        } catch (err) {
            lastErr = err;
            if (i + 1 < totalAttempts) {
                var brief = (err && err.message) ? err.message.split('\n')[0] : String(err);
                log.info('[retry] attempt ' + (i + 1) + '/' + totalAttempts + ' failed (' + brief + '), retrying in ' + delays[i] + 's');
                sleep(delays[i]);
            }
        }
    }
    return { ok: false, attempts: totalAttempts, lastErr: lastErr };
}


module.exports = {
    retryWithBackoff: retryWithBackoff
};
