'use strict';
/**
 * @module lib/secrets/env-file
 * @description `.env`-style parsing, shared so that every reader of a given
 * file agrees on what it means.
 *
 * Two consumers exist today and they answer different questions about the
 * same bytes: the `gina secrets:check` CLI handler asks *"would a bundle
 * started here resolve its placeholders?"*, and a file-backed secrets backend
 * asks *"what value does this key have?"*. If those two parsed differently —
 * on a quoted value, an `export ` prefix, a CRLF line ending — `secrets:check`
 * could report a clean bill of health for a file the runtime then reads
 * differently. Keeping one implementation makes that class of disagreement
 * impossible rather than merely unlikely.
 *
 * Deliberately minimal: no interpolation, no multi-line values, no `.env`
 * dialect extensions. It targets the format a POSIX shell would `source` —
 * which is how the documented container-entrypoint pattern
 * (`set -a; . secrets.env; set +a`) populates the environment — and agrees
 * with a real shell on the shapes a secrets file actually uses: quoted and
 * unquoted values, `export ` prefixes, blank lines, whole-line comments, and
 * (since #B269) trailing `#` comments.
 *
 * It is NOT a shell, and two divergences remain, both measured against `sh`:
 * `KEY = value` (a shell errors, trying to execute `KEY`; this accepts it and
 * trims), and `KEY="a"b"` (a shell concatenates to `ab`; this yields `a"b`).
 * Neither warrants a tokeniser here — but do not restate this module as
 * "whatever a POSIX shell does", because for those two shapes it is not.
 * Quote any value whose meaning could depend on shell word-splitting.
 */

var fs = require('fs');

/**
 * Parse `.env`-style content into a flat `KEY -> value` map.
 *
 * Recognised per line: blank lines and whole-line `#` comments are skipped; a
 * leading `export ` is stripped; the key is everything before the FIRST `=`; a
 * line with no `=` is skipped entirely. A TRAILING `#` comment is stripped when
 * the `#` is preceded by whitespace and sits outside quotes (#B269) — so
 * `PW=abc # note` is `abc`, while `PW=abc#def` and `PW="abc # in"` keep their
 * hash. A value wrapped in matching single or double quotes is unquoted, and
 * that still applies after a trailing comment is removed (`PW="abc" # note` is
 * `abc`, not `"abc"`). Keys and values are trimmed. Later duplicate keys
 * overwrite earlier ones, matching shell `source` semantics.
 *
 * The returned map is created with a `null` prototype, so a key such as
 * `constructor` or `__proto__` is an ordinary entry rather than an inherited
 * member — a plain `{}` would make `map.constructor` truthy for every file.
 *
 * @memberof module:lib/secrets/env-file
 * @function parseEnv
 * @param {string} raw - The file's contents
 * @returns {Object<string,string>} Parsed key/value map (null-prototype)
 *
 * @example
 * parseEnv('# db\nexport DB_PW=s3cr3t\nAPI_KEY="quoted"\nEMPTY=\nNOEQ\n');
 * // → { DB_PW: 's3cr3t', API_KEY: 'quoted', EMPTY: '' }
 * // `NOEQ` is absent: no `=`, so the line is skipped.
 */
/**
 * Truncate a raw (un-trimmed) value at an inline `#` comment, the way a POSIX
 * shell would when `source`-ing the same line.
 *
 * Two conditions must BOTH hold for a `#` to start a comment, and each exists
 * because dropping it corrupts a legitimate secret (all cases measured against
 * a real `sh` — see #B269):
 *
 * - **Preceded by whitespace.** `PW=abc#def` is the literal `abc#def` to a
 *   shell, so a `#` that directly follows the `=` or a non-blank character is
 *   an ordinary character. This is why the raw, UN-trimmed value is required:
 *   after trimming, `PW= # c` and `PW=#c` both start with `#` and become
 *   indistinguishable, yet the shell reads them as `''` and `'#c'`.
 * - **Outside quotes.** `PW="abc # inside"` keeps its hash; quoting is a
 *   complete escape hatch for a secret that genuinely contains ` #`.
 *
 * @memberof module:lib/secrets/env-file
 * @inner
 * @private
 * @param {string} raw - The value as it appears after the first `=`, un-trimmed
 * @returns {string} `raw` truncated at the comment, or `raw` unchanged
 *
 * @example
 * stripInlineComment('abc # note');      // → 'abc '
 * stripInlineComment('abc#def');         // → 'abc#def'   (no leading space)
 * stripInlineComment('"a # b" # note');  // → '"a # b" '  (first hash quoted)
 * stripInlineComment('#literal');        // → '#literal'  (directly after `=`)
 */
function stripInlineComment(raw) {
    var quote = null;
    for (var i = 0; i < raw.length; i++) {
        var ch = raw[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '#' && i > 0 && /\s/.test(raw[i - 1])) {
            return raw.slice(0, i);
        }
    }
    return raw;
}

function parseEnv(raw) {
    var map = Object.create(null);
    if (typeof raw !== 'string') {
        return map;
    }
    var lines = raw.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || /^#/.test(line)) continue;
        line = line.replace(/^export\s+/, '');
        var eq = line.indexOf('=');
        if (eq < 0) continue;
        var key = line.slice(0, eq).trim();
        // #B269 — strip BEFORE trimming: the shell's rule keys on the character
        // preceding the `#`, which trimming destroys.
        var val = stripInlineComment(line.slice(eq + 1)).trim();
        if ( /^".*"$/.test(val) || /^'.*'$/.test(val) ) {
            val = val.slice(1, -1);
        }
        map[key] = val;
    }
    return map;
}

/**
 * @typedef {object} EnvFileRead
 * @property {boolean}                   found - `true` when the file was read and parsed
 * @property {Object<string,string>|null} map  - Parsed map when `found`, else `null`
 * @property {string|null}               code  - `null` when `found`; else the `fs` error
 *   code — `'ENOENT'` for a genuinely absent path, `'EACCES'` / `'EISDIR'` / … for a
 *   path that exists but could not be read
 */

/**
 * Read and parse a `.env`-style file, reporting WHY a read failed.
 *
 * `parseEnvFile` collapses every failure to `null`, which makes a file that is
 * *missing* indistinguishable from one that exists but cannot be opened. Those
 * two deserve opposite handling: a missing layer is a legitimate state (a project
 * may ship a base file and add the per-scope one only on some targets), whereas a
 * layer that exists and cannot be read is an operator error — and silently
 * skipping it drops the bundle onto whatever lower-precedence layer remains,
 * which for a `["<base>", "<per-scope>"]` chain means quietly running on the
 * SHARED credential instead of the scope-specific one (#B267).
 *
 * Callers that must distinguish the two use this; `parseEnvFile` is kept as the
 * map-or-`null` convenience on top of it.
 *
 * @memberof module:lib/secrets/env-file
 * @function readEnvFile
 * @param {string} filePath - Absolute path to the file
 * @returns {EnvFileRead} Discriminated read result
 *
 * @example
 * var res = readEnvFile('/run/secrets.env');
 * if (!res.found && res.code !== 'ENOENT') {
 *     throw new Error('secrets file exists but cannot be read: ' + res.code);
 * }
 *
 * @example
 * // A genuinely absent layer is not an error — it simply contributes nothing:
 * readEnvFile('/run/never-created.env');   // → { found: false, map: null, code: 'ENOENT' }
 */
function readEnvFile(filePath) {
    var raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        // `e.code` is what discriminates: ENOENT (absent, fine) vs EACCES / EISDIR /
        // ENOTDIR / ELOOP (present but unusable). A dangling symlink reports ENOENT,
        // which is the correct reading — its target genuinely is not there.
        return { found: false, map: null, code: (e && e.code) ? e.code : 'EUNKNOWN' };
    }
    return { found: true, map: parseEnv(raw), code: null };
}

/**
 * Read and parse a `.env`-style file.
 *
 * Returns `null` — rather than throwing or returning an empty map — when the
 * file cannot be read, so a caller can tell "unreadable" apart from "readable
 * but empty". That distinction is load-bearing: an unreadable path is an
 * operator error worth reporting, whereas an empty file is a legitimate state
 * that should simply contribute no keys.
 *
 * ⚠️ This collapses *why* the read failed. A caller that must tell a missing
 * file apart from an unreadable one — which is the difference between "skip this
 * layer" and "refuse to boot" — wants {@link module:lib/secrets/env-file.readEnvFile}
 * instead.
 *
 * @memberof module:lib/secrets/env-file
 * @function parseEnvFile
 * @param {string} filePath - Absolute path to the file
 * @returns {Object<string,string>|null} Parsed map, or `null` if unreadable
 *
 * @example
 * var map = parseEnvFile('/run/secrets.env');
 * if (map === null) {
 *     // unreadable — surface it; do not treat as "no secrets"
 * }
 */
function parseEnvFile(filePath) {
    var res = readEnvFile(filePath);
    return res.found ? res.map : null;
}

module.exports = {
    parseEnv: parseEnv,
    parseEnvFile: parseEnvFile,
    readEnvFile: readEnvFile
};
