/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * TOTP — time-based one-time passwords, RFC 6238 (#COMPLY3).
 *
 * The second factor, and the smallest of the three slices: TOTP is a short,
 * fully-specified algorithm over HMAC, so gina implements it against the RFC
 * rather than taking a dependency. Compatible with every standard authenticator
 * (the `otpauth://` URI is the enrolment format they all read).
 *
 * What the bundle owns, because gina owns no user record:
 *
 *   - **Storing the secret.** It is a credential: encrypt it at rest, and treat
 *     it like a password in every log and error path.
 *   - **Replay defence.** {@link verifyTotp} returns the step `counter` it
 *     matched; persist the accepted counter per user and refuse anything not
 *     strictly greater. Without that, a code stays valid for its whole window
 *     and an observer who sees it can reuse it. The RFC is explicit that this is
 *     the verifier's job, and gina cannot do it without a place to write.
 *   - **Recovery codes.** Deliberately not built: they are single-use random
 *     strings, so `hashPassword` + your own table already expresses them, and a
 *     half-owned implementation would be worse than none.
 *
 * @module lib/authn/totp
 *
 * @example <caption>Enrolment</caption>
 * var secret = lib.authn.generateTotpSecret();
 * var uri    = lib.authn.otpauthURL({ secret: secret, account: user.email, issuer: 'Acme' });
 * // render `uri` as a QR code; store `secret` encrypted once the user confirms a code
 *
 * @example <caption>Verification, with replay defence</caption>
 * var res = lib.authn.verifyTotp(submitted, user.totpSecret);
 * if (!res.valid)                          { return deny(); }
 * if (res.counter <= user.totpLastCounter) { return deny(); }   // replay
 * user.totpLastCounter = res.counter;
 */

var crypto = require('crypto');

var BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** @constant {number} Default secret length in bytes (160 bits — the RFC 4226 recommendation). @inner @private */
var DEFAULT_SECRET_BYTES = 20;
/** @constant {number} Default step length in seconds. @inner @private */
var DEFAULT_STEP = 30;
/** @constant {number} Default digits. @inner @private */
var DEFAULT_DIGITS = 6;
/** @constant {string} Default HMAC algorithm. @inner @private */
var DEFAULT_ALGORITHM = 'sha1';
/**
 * Default acceptance window, in steps either side of now.
 *
 * One step (±30 s) absorbs ordinary clock drift between a phone and a server.
 * Widening it linearly widens the interval an observed code stays usable, so it
 * is a security parameter, not a convenience one.
 *
 * @constant
 * @type {number}
 * @inner
 * @private
 */
var DEFAULT_WINDOW = 1;

var ALLOWED_ALGORITHMS = [ 'sha1', 'sha256', 'sha512' ];

/**
 * Hard ceiling on the acceptance window, in steps.
 *
 * Ten steps is already five minutes of tolerance either side at the default
 * step — far past any real clock drift, and each step is an HMAC paid on the
 * request path.
 *
 * @constant
 * @type {number}
 * @inner
 * @private
 */
var MAX_WINDOW = 10;

/**
 * Encode bytes as RFC 4648 base32, unpadded.
 *
 * Unpadded because that is what authenticator apps expect in an `otpauth://`
 * URI; {@link base32Decode} accepts padding on the way back in regardless.
 *
 * @param {Buffer} buf
 * @returns {string}
 * @inner
 * @private
 */
function base32Encode(buf) {
    var out  = '';
    var bits = 0;
    var value = 0;
    for (var i = 0; i < buf.length; i++) {
        value = (value << 8) | buf[i];
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return out;
}

/**
 * Decode RFC 4648 base32.
 *
 * Tolerant on input, because a user retyping a secret from a screen will use
 * spaces and lowercase: padding, whitespace and case are all normalised. An
 * out-of-alphabet character is an error, not a silent skip — a mistyped secret
 * must fail loudly at enrolment rather than produce codes that never match.
 *
 * @param {string} str
 * @returns {Buffer}
 * @throws {Error} on a character outside the base32 alphabet.
 * @inner
 * @private
 */
function base32Decode(str) {
    // The type guard is load-bearing, not defensive tidying: `String(null)` is
    // "NULL", and N/U/L are all in the base32 alphabet — so a null secret
    // decoded to a NON-EMPTY, GLOBALLY CONSTANT key, and the `key.length === 0`
    // guard downstream never fired. Any account whose secret column was null
    // was verifiable by anyone able to compute the code for that constant.
    // Measured: verifyTotp(<code for "NULL">, null) returned {valid:true}.
    if (typeof str !== 'string') {
        throw new Error('[gina authn] TOTP secret must be a base32 string — got: ' + (str === null ? 'null' : typeof str));
    }
    var clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    var bits  = 0;
    var value = 0;
    var out   = [];
    for (var i = 0; i < clean.length; i++) {
        var idx = BASE32_ALPHABET.indexOf(clean[i]);
        if (idx === -1) {
            throw new Error('[gina authn] TOTP secret is not valid base32 — unexpected character: ' + JSON.stringify(clean[i]));
        }
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/**
 * Generate a TOTP secret.
 *
 * @param {number} [bytes=20] - entropy in bytes; 20 is the RFC 4226 recommendation.
 * @returns {string} base32, unpadded — the form an authenticator expects.
 * @throws {Error} when `bytes` is not a positive integer, or below 16.
 * @memberof module:lib/authn
 *
 * @example
 * var secret = lib.authn.generateTotpSecret(); // 'JBSWY3DPEHPK3PXP...'
 */
function generateTotpSecret(bytes) {
    var n = (typeof bytes === 'undefined') ? DEFAULT_SECRET_BYTES : bytes;
    if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n || n < 16) {
        throw new Error('[gina authn] generateTotpSecret(bytes): expects a whole number >= 16 (128 bits) — got: ' + JSON.stringify(bytes));
    }
    return base32Encode(crypto.randomBytes(n));
}

/**
 * Compute the HOTP value for one counter (RFC 4226 §5.3).
 *
 * @param {Buffer} key
 * @param {number} counter
 * @param {string} algorithm
 * @param {number} digits
 * @returns {string} zero-padded to `digits`.
 * @inner
 * @private
 */
function hotp(key, counter, algorithm, digits) {
    var buf = Buffer.alloc(8);
    // A 64-bit counter written as two 32-bit halves. At 30-second steps the high
    // half stays zero until epoch second 128849018880 — the year 6053 — but the
    // RFC specifies eight bytes and an authenticator hashes all eight.
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);

    var digest = crypto.createHmac(algorithm, key).update(buf).digest();
    var offset = digest[digest.length - 1] & 0x0f;
    var binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);

    var code = (binary % Math.pow(10, digits)).toString();
    while (code.length < digits) {
        code = '0' + code;
    }
    return code;
}

/**
 * Normalise and validate the shared option set.
 *
 * @param {object} [options]
 * @returns {{step: number, digits: number, algorithm: string, window: number}}
 * @throws {Error} on an unsupported value.
 * @inner
 * @private
 */
function resolveOptions(options) {
    options = options || {};
    var step      = (typeof options.step === 'undefined') ? DEFAULT_STEP : options.step;
    var digits    = (typeof options.digits === 'undefined') ? DEFAULT_DIGITS : options.digits;
    var algorithm = (typeof options.algorithm === 'undefined') ? DEFAULT_ALGORITHM : String(options.algorithm).toLowerCase();
    var window_   = (typeof options.window === 'undefined') ? DEFAULT_WINDOW : options.window;

    if (typeof step !== 'number' || !isFinite(step) || step <= 0 || Math.floor(step) !== step) {
        throw new Error('[gina authn] TOTP `step` must be a positive whole number of seconds — got: ' + JSON.stringify(options.step));
    }
    if (typeof digits !== 'number' || digits < 6 || digits > 10 || Math.floor(digits) !== digits) {
        throw new Error('[gina authn] TOTP `digits` must be a whole number in 6..10 — got: ' + JSON.stringify(options.digits));
    }
    if (ALLOWED_ALGORITHMS.indexOf(algorithm) === -1) {
        throw new Error('[gina authn] TOTP `algorithm` must be one of ' + ALLOWED_ALGORITHMS.join(', ') + ' — got: ' + JSON.stringify(options.algorithm));
    }
    if (typeof window_ !== 'number' || !isFinite(window_) || window_ < 0 || Math.floor(window_) !== window_ || window_ > MAX_WINDOW) {
        // Upper-bounded because each step costs an HMAC on the request path and
        // every extra step widens the interval an observed code stays usable.
        // Measured unbounded: window 100000 blocked the event loop for ~79 ms.
        throw new Error('[gina authn] TOTP `window` must be a whole number in 0..' + MAX_WINDOW + ' — got: ' + JSON.stringify(options.window));
    }
    return { step: step, digits: digits, algorithm: algorithm, window: window_ };
}

/**
 * Generate the TOTP code for a moment in time.
 *
 * Mostly useful for enrolment confirmation and for tests; a server rarely needs
 * to produce a code it is about to compare.
 *
 * @param {string} secret     - base32, as returned by {@link generateTotpSecret}.
 * @param {object} [options]
 * @param {number} [options.at]            - epoch MILLISECONDS; defaults to now.
 * @param {number} [options.step=30]       - step length in seconds.
 * @param {number} [options.digits=6]
 * @param {string} [options.algorithm=sha1] - `sha1` | `sha256` | `sha512`.
 * @returns {string} the zero-padded code.
 * @throws {Error} on an invalid secret or option.
 * @memberof module:lib/authn
 *
 * @example
 * lib.authn.generateTotp(secret);                    // code for right now
 * lib.authn.generateTotp(secret, { at: 59000 });     // RFC 6238 test vector time
 */
function generateTotp(secret, options) {
    var opts = resolveOptions(options);
    var key  = base32Decode(secret);
    if (key.length === 0) {
        throw new Error('[gina authn] TOTP secret is empty');
    }
    var at = (options && typeof options.at === 'number') ? options.at : Date.now();
    var counter = Math.floor((at / 1000) / opts.step);
    return hotp(key, counter, opts.algorithm, opts.digits);
}

/**
 * Verify a submitted TOTP code.
 *
 * Checks the current step and `window` steps either side, comparing in constant
 * time. Returns the matched step as an absolute `counter` — **persist it and
 * require the next accepted counter to be strictly greater**, or a code remains
 * reusable for its whole acceptance window.
 *
 * Never throws for a bad code: a malformed submission is `{valid: false}`, the
 * same shape as a wrong one, so an attacker learns nothing from the difference.
 * An invalid SECRET does throw — that is a configuration fault, not a login
 * attempt.
 *
 * @param {string} token      - the submitted code.
 * @param {string} secret     - base32 shared secret.
 * @param {object} [options]
 * @param {number} [options.at]             - epoch MILLISECONDS; defaults to now.
 * @param {number} [options.window=1]       - steps of tolerance either side.
 * @param {number} [options.step=30]
 * @param {number} [options.digits=6]
 * @param {string} [options.algorithm=sha1]
 * @returns {{valid: boolean, counter: ?number}} `counter` is the absolute step counter that matched — an index, not an offset from now — or `null`.
 * @throws {Error} when the secret is unusable.
 * @memberof module:lib/authn
 *
 * @example
 * var res = lib.authn.verifyTotp(self.post.code, user.totpSecret);
 * if (!res.valid || res.counter <= user.totpLastCounter) { return deny(); }
 * user.totpLastCounter = res.counter;
 */
function verifyTotp(token, secret, options) {
    var opts = resolveOptions(options);
    var key  = base32Decode(secret);
    if (key.length === 0) {
        throw new Error('[gina authn] TOTP secret is empty');
    }

    if (typeof token !== 'string' && typeof token !== 'number') {
        return { valid: false, counter: null };
    }
    var submitted = String(token).replace(/\s+/g, '');
    // A numeric submission has already lost any leading zero — `Number('012345')`
    // is 12345 — so re-pad before the length check. Measured without this: 9.6%
    // of genuine codes were rejected, exactly the ones beginning with 0. It fails
    // CLOSED, so it was never a bypass; it is the intermittent kind of breakage
    // that is expensive to diagnose in the field.
    if (typeof token === 'number' && /^[0-9]+$/.test(submitted)) {
        while (submitted.length < opts.digits) {
            submitted = '0' + submitted;
        }
    }
    if (!/^[0-9]+$/.test(submitted) || submitted.length !== opts.digits) {
        return { valid: false, counter: null };
    }

    var at      = (options && typeof options.at === 'number') ? options.at : Date.now();
    var counter = Math.floor((at / 1000) / opts.step);
    var submittedBuf = Buffer.from(submitted, 'utf8');

    for (var i = -opts.window; i <= opts.window; i++) {
        // A counter before the epoch has no meaning and would make hotp's
        // writeUInt32BE throw a RangeError — which would break the "never
        // throws for a bad code" contract for any `at` under one step.
        if (counter + i < 0) {
            continue;
        }
        var candidate = hotp(key, counter + i, opts.algorithm, opts.digits);
        var candidateBuf = Buffer.from(candidate, 'utf8');
        // Lengths are equal by construction (both zero-padded to `digits`, and
        // the submission was length-checked above), so this cannot throw.
        var match = false;
        try {
            match = crypto.timingSafeEqual(submittedBuf, candidateBuf);
        } catch (e) {
            match = false;
        }
        if (match) {
            return { valid: true, counter: counter + i };
        }
    }
    return { valid: false, counter: null };
}

/**
 * Build the `otpauth://` enrolment URI an authenticator app scans.
 *
 * Follows the de-facto Key Uri Format: the label carries `Issuer:Account` and
 * the `issuer` parameter repeats it, which is what makes apps display the
 * account under the right name.
 *
 * @param {object} params
 * @param {string} params.secret            - base32 secret.
 * @param {string} params.account           - the user-visible account name (an email, usually).
 * @param {string} [params.issuer]          - your application's name.
 * @param {number} [params.digits=6]
 * @param {number} [params.step=30]
 * @param {string} [params.algorithm=sha1]
 * @returns {string} the `otpauth://totp/...` URI.
 * @throws {Error} when `secret` or `account` is missing.
 * @memberof module:lib/authn
 *
 * @example
 * lib.authn.otpauthURL({ secret: s, account: 'ada@example.com', issuer: 'Acme' });
 * // otpauth://totp/Acme:ada%40example.com?secret=...&issuer=Acme&algorithm=SHA1&digits=6&period=30
 */
function otpauthURL(params) {
    params = params || {};
    if (typeof params.secret !== 'string' || params.secret.length === 0) {
        throw new Error('[gina authn] otpauthURL requires a `secret`');
    }
    if (typeof params.account !== 'string' || params.account.length === 0) {
        throw new Error('[gina authn] otpauthURL requires an `account` (the user-visible name shown in the authenticator)');
    }
    // Validate the secret HERE rather than let a QR code carry something the
    // authenticator will happily accept and the server can never verify.
    base32Decode(params.secret);
    var opts = resolveOptions(params);

    var label = params.issuer
        ? encodeURIComponent(params.issuer) + ':' + encodeURIComponent(params.account)
        : encodeURIComponent(params.account);

    var query = 'secret=' + encodeURIComponent(params.secret);
    if (params.issuer) {
        query += '&issuer=' + encodeURIComponent(params.issuer);
    }
    query += '&algorithm=' + opts.algorithm.toUpperCase();
    query += '&digits=' + opts.digits;
    query += '&period=' + opts.step;

    return 'otpauth://totp/' + label + '?' + query;
}

module.exports = {
    generateTotpSecret : generateTotpSecret,
    generateTotp       : generateTotp,
    verifyTotp         : verifyTotp,
    otpauthURL         : otpauthURL,
    // test seams — may change without notice
    _base32Encode      : base32Encode,
    _base32Decode      : base32Decode,
    _hotp              : hotp
};
