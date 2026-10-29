'use strict';
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/secrets/backends/exec
 * @description Exec-bridge resolver for `${secret:KEY}` placeholders: runs ONE
 * operator-declared command (`settings.secrets.exec.command`, argv form — no
 * shell) whose stdout must be a single flat JSON object of string values, and
 * layers that map UNDER the environment exactly as the file backend layers its
 * files. One generic bridge instead of per-vendor SDK backends: the vendor's
 * own CLI (`sops`, `vault`, `kubectl`) already owns auth, endpoints and
 * config, so gina ships no vendor SDK and no network code — the recipes in
 * the secrets guide show each CLI producing the stdout contract.
 *
 * **When NOT to use this.** The entrypoint decrypt remains the better answer
 * for SOPS / Vault / KMS: decrypting before the process starts keeps the
 * fetch off the boot path entirely, and the env backend already prefers what
 * lands in the environment. This tier exists for environments where the
 * entrypoint cannot be controlled; it *supports* the pattern, it does not
 * replace it.
 *
 * **Timing and cost.** The fetch runs eagerly at `build()` time — once per
 * bundle per config-load cycle (the file backend's documented cadence), for
 * the active env only, sequentially during boot. It NEVER runs per-request:
 * `Config.refresh()`'s only call site is commented out (see the note beside
 * it in `core/server.js`). A failing fetch throws out of `build()`, which
 * `selectBackend`'s caller turns into the per-bundle boot refusal — the same
 * path the file backend's unreadable-layer refusal (#B267) established.
 *
 * **Fail fast, never hang — the whole point.** The child is bounded by a
 * timeout (default 10000ms, 2x the CLI probe-class timeout used elsewhere in
 * the tree) and killed with SIGKILL. SIGKILL is load-bearing, not caution:
 * measured on this runtime, `spawnSync` with the default SIGTERM stays
 * BLOCKED past its timeout against a child that ignores SIGTERM, and then
 * reports `{error: ETIMEDOUT, status: 0}` — a hung boot followed by a result
 * a status-only check reads as success. SIGKILL cannot be ignored, so a
 * wedged fetch becomes a FAILED boot on schedule.
 *
 * **stdout is the secrets payload and never appears in any error, log or
 * message** — not on parse failure, not in the stderr tail, not at debug.
 * Command failure diagnostics quote stderr only (last lines), matching the
 * house child-process exemplars.
 *
 * **Trust model.** The command comes from bundle config, which already IS
 * code execution (build hooks are shelled from project config; bundle code
 * itself boots) — no new boundary is crossed. The child inherits
 * `process.env` because vendor CLIs need their own configuration
 * (`VAULT_ADDR`, `KUBECONFIG`, AWS credentials, `PATH`); pass auth material
 * via the environment, never argv (argv is visible in `ps`). Note the CLI
 * sweep (#B156) moves `GINA_*`/`VENDOR_*`/`USER_*` keys out of
 * `process.env` in CLI/daemon processes, so a fetch command cannot read
 * those through its inherited environment there.
 */

var cp         = require('child_process');
var envBackend = require('./env');

/**
 * Fetch timeout applied when the declaration omits `timeout`.
 * @constant {number} DEFAULT_TIMEOUT_MS
 * @memberof module:lib/secrets/backends/exec
 * @private
 */
var DEFAULT_TIMEOUT_MS = 10000;

/**
 * Upper bound on the child's captured stdout/stderr. Generous for any real
 * secrets map; not a config knob.
 * @constant {number} MAX_OUTPUT_BYTES
 * @memberof module:lib/secrets/backends/exec
 * @private
 */
var MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Run the declared command once and parse its stdout into a null-prototype
 * key/value map.
 *
 * Precondition: `spec` has passed `declaration.validateExecSpec` — this
 * function does not re-validate (a third validation site is the drift class
 * #B408 exists to prevent). Both consumers hold that precondition:
 * `selectBackend` validates before `build()`, and `secrets:check`'s mirror
 * validates through the same shared implementation before calling here.
 *
 * Result checking follows the MEASURED semantics of `spawnSync`, in an order
 * that is load-bearing: `.error` FIRST — a timed-out child can report
 * `{error: ETIMEDOUT, status: 0}`, which a status-first check reads as
 * success — then non-zero `.status` with a stderr tail, then the parse.
 *
 * @memberof module:lib/secrets/backends/exec
 * @function fetchExecMap
 * @param {{command: string[], timeout: (number|undefined)}} spec - The validated `settings.secrets.exec` declaration
 * @returns {Object<string, string>} Null-prototype map of the command's output
 * @throws {Error} On timeout, missing binary, spawn failure, non-zero exit,
 *   non-JSON / non-object / non-string-valued output. Messages never carry
 *   stdout; a non-string value's key is logged at debug level only.
 *
 * @example
 * var exec = require('./backends/exec');
 * var map = exec.fetchExecMap({ command: ['/opt/app/bin/print-secrets'] });
 * map.DB_PASSWORD;   // → 's3cret'  (the command printed {"DB_PASSWORD":"s3cret"})
 */
function fetchExecMap(spec) {
    var command = spec.command;
    var timeout = (typeof spec.timeout === 'number') ? spec.timeout : DEFAULT_TIMEOUT_MS;

    var res = cp.spawnSync(command[0], command.slice(1), {
        timeout    : timeout,
        // SIGKILL, deliberately: the default SIGTERM leaves spawnSync blocked
        // past its timeout against a SIGTERM-ignoring child (measured), which
        // is the hung boot this backend exists to rule out.
        killSignal : 'SIGKILL',
        encoding   : 'utf8',
        maxBuffer  : MAX_OUTPUT_BYTES
    });

    // .error before .status — the SIGTERM shape above is also why: an error
    // can coexist with status 0, and a status-first read calls that success.
    if (res.error) {
        if (res.error.code === 'ETIMEDOUT') {
            throw new Error('`settings.secrets.exec` command timed out after ' + timeout
                + 'ms and was killed — the fetch must complete within `timeout` or boot refuses rather than hang');
        }
        if (res.error.code === 'ENOENT') {
            throw new Error('`settings.secrets.exec` command not found: ' + command[0]);
        }
        throw new Error('`settings.secrets.exec` command could not be run: '
            + (res.error.message || res.error));
    }
    if (res.status !== 0) {
        // stderr tail only — stdout is the secrets payload and is never echoed.
        var errTail = String(res.stderr || '').trim().split('\n').slice(-3).join(' | ');
        throw new Error('`settings.secrets.exec` command failed (exit ' + res.status + ')'
            + (errTail ? ' — ' + errTail : ''));
    }

    var parsed;
    try {
        parsed = JSON.parse(res.stdout);
    } catch (parseErr) {
        // No excerpt, deliberately: a malformed output may still be secrets.
        throw new Error('`settings.secrets.exec` command output is not valid JSON —'
            + ' the command must print one flat JSON object of string values (stdout is never echoed)');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('`settings.secrets.exec` command output must be a single flat JSON object'
            + ' of string values (stdout is never echoed)');
    }

    var map  = Object.create(null);
    var keys = Object.keys(parsed);
    for (var i = 0; i < keys.length; i++) {
        if (typeof parsed[keys[i]] !== 'string') {
            // The key rides the debug channel only — the message reaches
            // user-facing surfaces, same hygiene as the resolve-miss contract.
            try {
                console.debug('[secrets][exec] output value for `' + keys[i] + '` is not a string');
            } catch (noLogger) { /* logger not up yet — diagnostics are best-effort */ }
            throw new Error('`settings.secrets.exec` command output carries a non-string value'
                + ' (the offending key is logged at debug level; stdout is never echoed)');
        }
        map[keys[i]] = parsed[keys[i]];
    }
    return map;
}

/**
 * Build an exec-backed resolver: fetch the map eagerly — once per
 * config-load cycle, mirroring the file backend's documented rationale
 * ("resolution walks the whole config and would otherwise re-run the fetch
 * for each placeholder") — then resolve each key environment-first.
 *
 * @memberof module:lib/secrets/backends/exec
 * @function build
 * @param {{command: string[], timeout: (number|undefined)}} spec - The validated `settings.secrets.exec` declaration
 * @returns {{resolve: function(string): string}} Env-over-exec resolver
 * @throws {Error} Propagates every `fetchExecMap` failure — the caller
 *   (`core/config.js::loadBundleConfig`) turns it into a per-bundle boot
 *   refusal, exactly as it does for an unreadable file layer (#B267).
 *
 * @example
 * var exec = require('./backends/exec');
 * var backend = exec.build({ command: ['/opt/app/bin/print-secrets'], timeout: 5000 });
 * process.env.API_KEY = 'from-env';
 * backend.resolve('API_KEY');   // → 'from-env'  (environment beats the fetched map)
 */
function build(spec) {
    var merged = fetchExecMap(spec);

    // Name the tier and its yield, count only — never keys, never values.
    // A misconfigured command is otherwise indistinguishable from a map that
    // merely lacks the key: both surface as the same fail-closed error,
    // several frames away.
    try {
        console.debug('[secrets][exec] fetched ' + Object.keys(merged).length
            + ' keys via `' + spec.command[0] + '`');
    } catch (noLogger) { /* logger not up yet — diagnostics are best-effort */ }

    return {
        resolve: function (key) {
            // Environment tiers first — delegate to the env backend rather
            // than re-implementing its two-tier `getEnvVar` -> `process.env`
            // read (#B156/#B270), so the tiers can never disagree about what
            // "set" means. It throws on miss, which here means "not in the
            // environment".
            try {
                return envBackend.resolve(key);
            } catch (notInEnv) {
                // fall through to the fetched map
            }

            var value = merged[key];
            if (typeof value === 'string' && value !== '') {
                // #B268 parity with the file tier: "set but empty" and
                // "absent" are indistinguishable through the env backend, and
                // the empty shape can mean a failed `export X="$(fetch ...)"`
                // — the case this ordering exists to make visible. Warn,
                // never fatal, naming only the KEY.
                if (envBackend.isPresentButEmpty(key)) {
                    try {
                        console.warn('[secrets][exec] `' + key + '` is present but EMPTY in the'
                            + ' environment; falling back to the exec tier. If the environment was'
                            + ' meant to supply it, whatever exports it produced an empty value.');
                    } catch (noLogger) { /* logger not up yet — diagnostics are best-effort */ }
                }
                return value;
            }

            // Same failure shape as the env backend: the message never names
            // the key (it reaches user-facing surfaces), while the key rides
            // on a non-enumerable property for debug logging.
            var err = new Error('Secret resolution failed');
            Object.defineProperty(err, '_ginaSecretKey', {
                value: key,
                enumerable: false,
                configurable: true,
                writable: true
            });
            throw err;
        }
    };
}

module.exports = {
    build: build,
    fetchExecMap: fetchExecMap
};
