'use strict';
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/secrets/declaration
 * @description Shared validation of the `settings.secrets` declaration,
 * consumed by BOTH the runtime dispatch (`selectBackend`,
 * `lib/secrets/src/main.js`) and the `secrets:check` CLI gate
 * (`lib/cmd/secrets/check.js`). One implementation, so the gate and the
 * runtime cannot drift.
 *
 * Why this module exists (#B408): the mirror had ALREADY drifted twice, both
 * times in the LAX direction — the runtime gained the whitespace-only entry
 * refusal (#B271, `.trim()`) and the empty-path-segment refusal (#B272,
 * `'//'`) while `secrets:check` kept an older copy of the loop, so
 * `settings.secrets.file: [" "]` and a path whose token collapsed to `//`
 * passed the CI gate GREEN while boot REFUSED. That is precisely the
 * checker-vs-runtime disagreement the command exists to prevent, and the
 * second occurrence of the drift class #B263 already paid for once on the
 * source-walk axis (cured the same way: one shared implementation, in
 * `./sources`).
 *
 * Contract notes:
 * - **Pure and ambient-free.** No `_()`, no `requireJSON`, no requires — the
 *   zero-setup `require('lib/secrets')` path stays zero-setup.
 * - **Inputs are POST-substitution values.** The runtime validates what the
 *   config loader's `whisper` pass produced; the CLI whispers with its own
 *   `buildReps` dictionary first and hands the result here. Validating the
 *   same (resolved) form on both sides is what makes the verdicts identical.
 * - **First-error-wins, entries in order.** The returned array carries AT
 *   MOST ONE error, mirroring both consumers: the runtime throws on the
 *   first failing entry, the CLI reports it and stops reading the tier.
 * - Errors are `{code, message}` — the `message` is the exact user-facing
 *   text (the runtime throws it verbatim, so realigning a message here IS a
 *   runtime behaviour change); the `code` lets a consumer add surface-local
 *   context (the CLI appends its `--scope`/`--env` hint on
 *   `file-unresolved-token`) without forking the shared text.
 */

/**
 * Matches any surviving `${…}` config token. Kept here — beside the guard
 * that uses it — rather than in each consumer; `secrets:check` used to carry
 * its own copy (`UNRESOLVED_TOKEN`) of this exact source.
 *
 * Note it also matches `${secret:…}` — the placeholder guard runs FIRST so a
 * secret placeholder reports as what it is, never as a generic token.
 *
 * @constant {RegExp} TOKEN_RE
 * @memberof module:lib/secrets/declaration
 * @private
 */
var TOKEN_RE = /\$\{[^}]*\}/;

/**
 * Validate the declared `settings.secrets.file` entries, POST-substitution.
 *
 * The four guards, in the order the runtime has always applied them —
 * per entry, first failure wins:
 *
 * 1. **Entry shape** — a non-string, or a string that is empty once
 *    trimmed. #B271: the trim matters because the schema's `minLength: 1`
 *    counts a space, so `[" "]` used to clear both layers and build a tier
 *    that could never resolve anything, visible only as a suppressed debug
 *    line.
 * 2. **`${secret:…}` placeholder** — a secrets file cannot itself be named
 *    by a secret: the backend that would resolve the placeholder is the one
 *    being built.
 * 3. **Unresolved `${…}` token** — unknown tokens are preserved verbatim by
 *    design, so a typo would otherwise become a silent lookup for a
 *    literally-named file that never exists, and every secret would fall
 *    through to a confusing fail-closed error.
 * 4. **Empty path segment (`//`)** — #B272: a token that resolved to an
 *    EMPTY string leaves nothing for guard 3 to catch:
 *    `${homedir}/${scope}/secrets.env` with an empty scope collapses to
 *    `<home>//secrets.env`, which POSIX reads as `<home>/secrets.env` — a
 *    silent read of the WRONG file, one directory up from the intended one.
 *    The empty segment is the only surviving trace. This CANNOT distinguish
 *    that from the benign cause — a token carrying a trailing slash, e.g.
 *    `GINA_HOMEDIR=/opt/gina/` (operator-supplied, and nothing in the path
 *    chain normalises it) — because by here both have collapsed to the same
 *    string. It refuses either way, deliberately: the dangerous case runs
 *    the bundle on the wrong credential in silence, and the file backend
 *    already refuses on the same reasoning when a declared layer exists but
 *    cannot be read (#B267). The benign case costs one character to fix and
 *    the message names it, so the error must NOT assert a cause it cannot
 *    know.
 *
 * @memberof module:lib/secrets/declaration
 * @function validateFilePaths
 * @param {Array} paths - Declared file entries, array form, post-substitution
 * @returns {Array<{code: string, message: string}>} Empty when every entry
 *   passes; otherwise exactly one error — code one of `file-entry-shape`,
 *   `file-secret-placeholder`, `file-unresolved-token`, `file-empty-segment`
 *
 * @example
 * var declaration = require('./declaration');
 * declaration.validateFilePaths(['/etc/app/base.env']);      // → []
 * declaration.validateFilePaths([' ']);                      // → [{code: 'file-entry-shape', …}]
 *
 * @example
 * // A token that resolved to an empty value collapses a segment:
 * declaration.validateFilePaths(['/home/u//secrets.env']);
 * // → [{code: 'file-empty-segment', message: '…contains an empty path segment…'}]
 */
function validateFilePaths(paths) {
    for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        if (typeof p !== 'string' || p.trim() === '') {
            return [{
                code: 'file-entry-shape',
                message: '`settings.secrets.file` must be a non-empty string or an array of them'
            }];
        }
        if (p.indexOf('${secret:') > -1) {
            return [{
                code: 'file-secret-placeholder',
                message: '`settings.secrets.file` cannot contain a `${secret:…}` placeholder'
            }];
        }
        if (TOKEN_RE.test(p)) {
            return [{
                code: 'file-unresolved-token',
                message: '`settings.secrets.file` contains an unresolved `${…}` token: ' + p
            }];
        }
        if (p.indexOf('//') > -1) {
            return [{
                code: 'file-empty-segment',
                message: '`settings.secrets.file` contains an empty path segment (`//`), so it does not name the file it appears to — POSIX reads `<a>//<b>` as `<a>/<b>`. Either a `${…}` token resolved to an empty value (the path then silently drops a directory), or a token carries a trailing slash. Remove the doubled separator or fix the token: ' + p
            }];
        }
    }
    return [];
}

/**
 * Validate the `settings.secrets` block itself — shape, key roster, and
 * tier exclusivity — before any tier-specific validation runs.
 *
 * The guards, in order:
 *
 * 1. **Block shape** — the block must be a plain object (`null` is handled
 *    by the callers as "not declared" and never reaches here). The schema
 *    says `"type": "object"`; no runtime validator loads the schema, so
 *    this is where that promise is enforced.
 * 2. **Unknown keys refused, not ignored** — runtime parity with the
 *    schema's `additionalProperties: false`. A typo'd key (`flie`, `exce`)
 *    used to degrade silently to the env-only default, which reads as a
 *    healthy boot with a mysteriously missing tier; refusing makes the typo
 *    loud at the one moment someone is looking.
 * 3. **`file` and `exec` do not combine** — an ordering between the two
 *    tiers has never been defined, and one shipped now would be locked
 *    forever (`additionalProperties: false` cuts both ways). Refusal is
 *    relaxable additively if a real layering case ever arrives. The case
 *    this WILL hit: a shared `settings.json` declares `file`, a bundle opts
 *    into `exec`, and the config merge folds both into one block — the
 *    escape is the pinned null opt-out, `"file": null` beside the bundle's
 *    `exec`, which the error message names.
 *
 * @memberof module:lib/secrets/declaration
 * @function validateBlock
 * @param {*} block - The declared `settings.secrets` value (non-null)
 * @returns {Array<{code: string, message: string}>} Empty when the block
 *   passes; otherwise exactly one error — code one of `block-shape`,
 *   `block-unknown-key`, `block-both-tiers`
 *
 * @example
 * var declaration = require('./declaration');
 * declaration.validateBlock({ file: null, exec: { command: ['/opt/bin/fetch-secrets'] } });  // → []
 * declaration.validateBlock({ flie: ['/etc/a.env'] });  // → [{code: 'block-unknown-key', …}]
 */
function validateBlock(block) {
    if (typeof block !== 'object' || Array.isArray(block)) {
        return [{
            code: 'block-shape',
            message: '`settings.secrets` must be an object (or null to opt out)'
        }];
    }
    for (var key in block) {
        if (!Object.prototype.hasOwnProperty.call(block, key)) { continue; }
        if (key !== 'file' && key !== 'exec') {
            return [{
                code: 'block-unknown-key',
                message: '`settings.secrets` carries an unknown key `' + key + '` — the declared keys are `file` and `exec`. Unknown keys are refused rather than ignored: a typo here would silently drop a whole secrets tier'
            }];
        }
    }
    var fileDeclared = (typeof block.file !== 'undefined' && block.file !== null);
    var execDeclared = (typeof block.exec !== 'undefined' && block.exec !== null);
    if (fileDeclared && execDeclared) {
        return [{
            code: 'block-both-tiers',
            message: '`settings.secrets` declares BOTH `file` and `exec` — pick one; the two tiers do not layer. A bundle inheriting a project-wide `file` chain opts out of it with `"file": null` beside its own `exec` block'
        }];
    }
    return [];
}

/**
 * Validate the declared `settings.secrets.exec` spec, POST-substitution.
 *
 * The guards, in order — first failure wins:
 *
 * 1. **Spec shape** — a plain object carrying `command`.
 * 2. **Unknown spec keys refused** — same schema-parity reasoning as the
 *    block level, and it protects forward too: a config written for a newer
 *    gina (say, a future `format` key) fails LOUDLY on an older one instead
 *    of silently ignoring the option and misreading the output.
 * 3. **`command` shape** — a non-empty array of non-empty strings, argv
 *    form: element 0 is the binary, no shell is ever involved (the safe
 *    half of the house child-process precedent).
 * 4. **`${secret:…}` placeholder** — the backend that would resolve it is
 *    the one being built (the file tier's identical rule).
 * 5. **Unresolved `${…}` token** — same reasoning as the file tier: unknown
 *    tokens survive substitution verbatim, so a typo would become a
 *    literally-named binary or argument.
 *    ⚠️ The file tier's `//` empty-segment guard is deliberately NOT
 *    mirrored here: argv elements legitimately carry `//` (URLs —
 *    `https://vault:8200`). The residual — a token resolving to EMPTY
 *    inside an element — is documented in the guide instead: the command's
 *    own failure is the backstop, and recipes prefer whole-element tokens.
 * 6. **`timeout` shape** — when declared, a positive integer (milliseconds).
 *
 * @memberof module:lib/secrets/declaration
 * @function validateExecSpec
 * @param {*} spec - The declared `settings.secrets.exec` value (non-null)
 * @returns {Array<{code: string, message: string}>} Empty when the spec
 *   passes; otherwise exactly one error — code one of `exec-spec-shape`,
 *   `exec-spec-unknown-key`, `exec-command-shape`,
 *   `exec-command-secret-placeholder`, `exec-command-unresolved-token`,
 *   `exec-timeout-shape`
 *
 * @example
 * var declaration = require('./declaration');
 * declaration.validateExecSpec({ command: ['/opt/bin/fetch-secrets', '--json'] });  // → []
 * declaration.validateExecSpec({ command: [] });  // → [{code: 'exec-command-shape', …}]
 */
function validateExecSpec(spec) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        return [{
            code: 'exec-spec-shape',
            message: '`settings.secrets.exec` must be an object with a `command` array'
        }];
    }
    for (var key in spec) {
        if (!Object.prototype.hasOwnProperty.call(spec, key)) { continue; }
        if (key !== 'command' && key !== 'timeout') {
            return [{
                code: 'exec-spec-unknown-key',
                message: '`settings.secrets.exec` carries an unknown key `' + key + '` — the declared keys are `command` and `timeout`'
            }];
        }
    }
    if (!Array.isArray(spec.command) || !spec.command.length) {
        return [{
            code: 'exec-command-shape',
            message: '`settings.secrets.exec.command` must be a non-empty array of strings — argv form: the first element is the binary, no shell is involved'
        }];
    }
    for (var i = 0; i < spec.command.length; i++) {
        var el = spec.command[i];
        if (typeof el !== 'string' || el.trim() === '') {
            return [{
                code: 'exec-command-shape',
                message: '`settings.secrets.exec.command` must be a non-empty array of strings — argv form: the first element is the binary, no shell is involved'
            }];
        }
        if (el.indexOf('${secret:') > -1) {
            return [{
                code: 'exec-command-secret-placeholder',
                message: '`settings.secrets.exec.command` cannot contain a `${secret:…}` placeholder — the backend that would resolve it is the one being built'
            }];
        }
        if (TOKEN_RE.test(el)) {
            return [{
                code: 'exec-command-unresolved-token',
                message: '`settings.secrets.exec.command` contains an unresolved `${…}` token: ' + el
            }];
        }
    }
    if (typeof spec.timeout !== 'undefined' && spec.timeout !== null) {
        if (typeof spec.timeout !== 'number' || !isFinite(spec.timeout)
            || spec.timeout !== Math.floor(spec.timeout) || spec.timeout < 1) {
            return [{
                code: 'exec-timeout-shape',
                message: '`settings.secrets.exec.timeout` must be a positive integer (milliseconds)'
            }];
        }
    }
    return [];
}

module.exports = {
    validateFilePaths: validateFilePaths,
    validateBlock: validateBlock,
    validateExecSpec: validateExecSpec
};
