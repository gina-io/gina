'use strict';
/**
 * @module lib/secrets/backends/file
 * @description Backend that layers one or more `.env`-style files *underneath*
 * the environment.
 *
 * **A NON-EMPTY environment value always wins.** A value present in
 * `process.gina` / `process.env` is returned even when a file also defines the
 * key. That ordering is deliberate and is the opposite of what `.env`-file
 * tooling usually does: every production mechanism for delivering a secret to a
 * gina bundle — a Kubernetes `envFrom: secretRef`, an ECS task-definition secret,
 * `sops exec-env`, a CI-exported variable — arrives through the environment.
 * If a file won, a stale plaintext file baked into an image would silently
 * shadow the secret the platform injected, and the bundle would run with the
 * wrong credential while looking perfectly healthy. Making the file the
 * *fallback* means it can only ever fill a gap, never override a deployment.
 *
 * **The "non-empty" qualifier is load-bearing, and deliberately NOT a refusal**
 * (#B268). A variable that is SET but EMPTY is treated as absent, so the file
 * tier fills it. That is what makes the common local shape work: Docker Compose
 * `environment: ["X=${X}"]` with the outer `X` unset puts an empty-but-SET `X`
 * into the container (measured), and refusing there would break setups that are
 * working today. But the same shape also arises when an entrypoint's
 * `export X="$(fetch …)"` FAILS — and there the file silently supplying a stale
 * value is exactly the shadowing this ordering exists to prevent. Since the two
 * are indistinguishable from inside the process, the file tier does not guess:
 * it fills the gap and WARNS (see `resolve`), so the dangerous case is visible
 * without the benign one becoming fatal.
 *
 * Files are layered in declaration order, later entries winning, so a caller
 * can express `["<base>", "<per-scope>"]` and have the scope-specific file
 * override shared defaults. A file that does not exist contributes nothing and
 * is not an error — a project may legitimately ship a base file and add the
 * per-scope one only on some targets. A file that EXISTS but cannot be read is
 * a different matter and is fatal (#B267): silently skipping it would drop that
 * chain onto the shared base file, i.e. run the bundle on the wrong credential
 * with no signal at all.
 *
 * This backend does NOT decrypt. Pointing it at an encrypted file yields
 * ciphertext, silently. For SOPS / Vault / KMS, keep decrypting at the
 * container entrypoint so the values land in the environment, which this
 * backend already prefers.
 */

var envBackend = require('./env');
var envFile    = require('../env-file');

// The present-but-empty probe behind the #B268 warning moved to the env
// backend (`envBackend.isPresentButEmpty`) when the exec backend arrived —
// two lower tiers each carrying a private copy of "what does the environment
// say" is the #B270/#B408 drift class. Same bytes, one home.
var isEnvPresentButEmpty = envBackend.isPresentButEmpty;

/**
 * Build a backend that reads the environment first and the given files second.
 *
 * @memberof module:lib/secrets/backends/file
 * @function build
 * @param {string[]} paths - Absolute, already-substituted file paths, lowest precedence first
 * @returns {{resolve: function(string): string}} A backend honouring the `lib/secrets` contract
 * @throws {Error} When a declared path EXISTS but cannot be read (`EACCES`, `EISDIR`, …).
 *   A genuinely absent path (`ENOENT`) is not an error and contributes nothing (#B267).
 *
 * @example
 * var backend = build(['/home/u/.myproject/secrets.env',
 *                      '/home/u/.myproject/production/secrets.env']);
 * backend.resolve('DB_PASSWORD');
 * // non-empty env value if set; else the production file's; else the base file's;
 * // else throws Error('Secret resolution failed')
 *
 * @example
 * // An unreadable layer refuses at BUILD time rather than degrading silently:
 * // chmod 000 /home/u/.myproject/production/secrets.env
 * build(['/home/u/.myproject/secrets.env',
 *        '/home/u/.myproject/production/secrets.env']);
 * // → throws '`settings.secrets.file` names a file that exists but cannot be read: … (EACCES)'
 */
function build(paths) {
    // Layer eagerly, once per config-load cycle, rather than statting on every
    // key: resolution walks the whole config and would otherwise re-read the
    // same files for each placeholder.
    var merged = Object.create(null);
    for (var i = 0; i < paths.length; i++) {
        var res = envFile.readEnvFile(paths[i]);

        // #B267 — a path that EXISTS but cannot be read is an operator error, not
        // an absent layer. Skipping it silently drops a `["<base>", "<per-scope>"]`
        // chain onto the base file, so the bundle boots healthily on the SHARED
        // credential. Refuse instead: the caller (core/config.js::loadBundleConfig)
        // reports this as a config error and the boot stops with the path named.
        if (!res.found && res.code !== 'ENOENT') {
            throw new Error('`settings.secrets.file` names a file that exists but cannot be read: '
                + paths[i] + ' (' + res.code + ')');
        }

        // Name each layer and whether it was found. A misresolved path is
        // otherwise indistinguishable from a file that simply lacks the key:
        // both surface as the same fail-closed error, several frames away.
        try {
            console.debug('[secrets][file] ' + (res.found ? 'loaded ' : 'ABSENT ')
                + paths[i] + (res.found ? ' (' + Object.keys(res.map).length + ' keys)' : ''));
        } catch (noLogger) { /* logger not up yet — diagnostics are best-effort */ }
        if (!res.found) continue;            // absent file: contributes nothing, not an error
        for (var key in res.map) {
            merged[key] = res.map[key];      // later path wins
        }
    }

    return {
        resolve: function (key) {
            // Environment tiers first — delegate to the env backend rather than
            // re-implementing its two-tier `getEnvVar` -> `process.env` read
            // (#B156), so the two can never disagree about what "set" means.
            // It throws on miss, which here means "not in the environment".
            try {
                return envBackend.resolve(key);
            } catch (notInEnv) {
                // fall through to the file layer
            }

            var value = merged[key];
            if (typeof value === 'string' && value !== '') {
                // #B268 — the env backend reports "set but empty" and "absent"
                // identically, so reaching here does not say which happened. When
                // it was the former, the file is about to override a value the
                // environment DID carry, which is the one case this ordering is
                // meant to make impossible. Warn (never fatal — see the module
                // header for why refusing would break Compose-style passthrough),
                // at `warn` so it survives the default `info` log hierarchy, and
                // name only the KEY: the message reaches user-facing surfaces.
                if (isEnvPresentButEmpty(key)) {
                    try {
                        console.warn('[secrets][file] `' + key + '` is present but EMPTY in the'
                            + ' environment; falling back to the file tier. If the environment was'
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
    build: build
};
