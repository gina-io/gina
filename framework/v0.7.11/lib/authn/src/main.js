/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * lib/authn — authentication hardening primitives (#COMPLY3).
 *
 * **Hooks and helpers, never an identity provider.** Gina does not own a user
 * record, a credential store, a login route, or a session id — those are the
 * bundle's. What this module supplies is the handful of primitives that are
 * dangerous to hand-roll: a memory-hard password hash with a self-describing
 * encoding, a constant-time verify, and a password policy check.
 *
 * It composes with what already ships rather than replacing it:
 *
 *   1. `validatePasswordPolicy(pw)` — at registration / password change.
 *   2. `hashPassword(pw)`           — store the returned PHC string.
 *   3. `createLockout()`            — refuse an account under attack BEFORE
 *                                     spending a KDF on it.
 *   4. `verifyPassword(pw, stored)` — at login; pair it with `dummyVerify` on
 *                                     the account-not-found branch.
 *   5. `req.login(user, done)`      — core/router.js rotates the session id and
 *                                     binds `req.session.user` (#COMPLY4).
 *
 * Step 5 is where authentication ENDS and authorization begins: `lib/authz-gate`
 * reads `req.session.user`, so nothing here ever touches a session.
 *
 * **Encoding.** Hashes are PHC strings — `$scrypt$ln=17,r=8,p=1$<salt>$<hash>`
 * (base64, unpadded). Self-describing, so the parameters travel with the hash
 * and can be raised later without a flag day: {@link needsRehash} reports which
 * stored hashes are below the current policy, and the login action upgrades
 * them transparently (it is the only moment the plaintext is in hand).
 *
 * **Why scrypt.** It is memory-hard and lives in node core, so a consumer needs
 * no native addon to get a defensible default — the framework must work out of
 * the box. Argon2id is the stronger primitive where a consumer can install it;
 * {@link verifyPassword} therefore ALSO verifies `$argon2*$` and `$2a/2b/2y$`
 * (bcrypt) hashes through the consumer's own `argon2` / `bcrypt` package, so a
 * bundle migrating onto gina keeps its existing hashes working. Gina never
 * MINTS those formats — one mint path, one set of parameters to reason about.
 *
 * **What this module deliberately does NOT do:** no credential storage, no user
 * lookup, no login route, no session handling, no password reset or email
 * flows, no breach-corpus checks (that needs a network service — see the guide
 * for the k-anonymity pattern), no password history (it needs the store gina
 * does not own).
 *
 * @module lib/authn
 * @see module:lib/authz-gate — the authorization half; reads `req.session.user`
 *
 * @example
 * // in a bundle's login action
 * var authn = require('gina').lib.authn;
 *
 * authn.verifyPassword(self.post.password, account.passwordHash, function (err, ok) {
 *     if (err) { return self.throwError(500); }
 *     if (!ok) { return self.renderJSON({ error: 'invalid credentials' }); }
 *     self.req.login({ id: account.id, roles: account.roles }, function (loginErr) {
 *         if (loginErr) { return self.throwError(500); }
 *         self.redirect('/dashboard');
 *     });
 * });
 */

var crypto  = require('crypto');
var lockout = require('./lockout');
var totp    = require('./totp');

/**
 * Current scrypt cost parameters.
 *
 * `ln` is the base-2 logarithm of scrypt's `N`: `N = 2^17 = 131072`, which with
 * `r = 8` puts the working set at roughly 128 MiB and a single hash in the
 * ~100 ms range on 2026 server hardware — the OWASP Password Storage guidance
 * for scrypt. `p = 1` keeps one hash on one core so the cost is memory, not
 * parallelism.
 *
 * Raising these is a supported change: existing hashes keep verifying (their
 * own parameters are encoded in them) and {@link needsRehash} starts reporting
 * `true` for them.
 *
 * @constant
 * @type {{ln: number, r: number, p: number}}
 * @inner
 * @private
 */
var SCRYPT_PARAMS = { ln: 17, r: 8, p: 1 };

/** @constant {number} Salt length in bytes (128 bits). @inner @private */
var SALT_BYTES = 16;
/** @constant {number} Derived-key length in bytes (256 bits). @inner @private */
var KEY_BYTES = 32;

/**
 * Upper bound on an accepted password, in bytes of UTF-8.
 *
 * A memory-hard KDF is a denial-of-service surface: the work is paid by the
 * server, and an unbounded input lets a caller choose how much. 1024 bytes is
 * far above any real passphrase and far below anything that matters. Rejected
 * as an ERROR rather than silently truncated — a silent truncation would make
 * two different passwords authenticate each other.
 *
 * @constant
 * @type {number}
 * @inner
 * @private
 */
var MAX_PASSWORD_BYTES = 1024;

/**
 * Default minimum password LENGTH.
 *
 * 12 with no composition rules, per NIST SP 800-63B: mandatory character-class
 * mixing measurably pushes users toward predictable substitutions, so length is
 * the requirement and composition is available but off.
 *
 * @constant
 * @type {number}
 * @inner
 * @private
 */
var DEFAULT_MIN_LENGTH = 12;

/**
 * Concurrency ceiling for in-flight scrypt operations.
 *
 * Each hash reserves ~128 MiB and occupies a libuv threadpool slot (default
 * size 4). Without a ceiling, a burst of login attempts is a memory-exhaustion
 * vector and starves every other threadpool user — fs, zlib, dns. Two keeps a
 * burst bounded while leaving threadpool capacity for the rest of the process.
 *
 * @constant
 * @type {number}
 * @inner
 * @private
 */
var DEFAULT_MAX_CONCURRENT = 2;

/** @type {number} In-flight scrypt operations. @inner @private */
var _inFlight = 0;
/** @type {Array<function>} FIFO of queued scrypt starters. @inner @private */
var _queue = [];
/** @type {number} Effective concurrency ceiling. @inner @private */
var _maxConcurrent = DEFAULT_MAX_CONCURRENT;

/**
 * Ceiling on the number of hashes WAITING for a slot.
 *
 * The concurrency gauge bounds how much work runs at once; without this, it did
 * not bound how much work could be PROMISED. Set generously — real login
 * traffic never approaches it — so reaching it means the endpoint is under load
 * that belongs to a rate limiter, not to a KDF.
 *
 * @constant
 * @type {number}
 * @inner
 * @private
 */
var DEFAULT_MAX_QUEUE = 100;
/** @type {number} Effective queue ceiling. @inner @private */
var _maxQueue = DEFAULT_MAX_QUEUE;

/**
 * Run `fn` once a concurrency slot is free, releasing the slot when it calls
 * back.
 *
 * FIFO, so a queued attempt cannot be starved by later arrivals. `release` is
 * latched: a KDF callback that fired twice would otherwise corrupt the counter
 * and permanently shrink the pool.
 *
 * @param {function} fn - receives `release` and must call it exactly once.
 * @returns {void}
 * @inner
 * @private
 */
function withSlot(fn, onRejected) {
    function start() {
        _inFlight++;
        var released = false;
        fn(function release() {
            if (released) {
                return;
            }
            released = true;
            _inFlight--;
            if (_queue.length > 0) {
                var next = _queue.shift();
                next();
            }
        });
    }
    if (_inFlight < _maxConcurrent) {
        return start();
    }
    // Shed load rather than queue without limit. An unbounded queue made the
    // documented account-not-found pattern an amplifier: 30 requests for
    // accounts that DO NOT EXIST — no credentials, no account needed — pushed a
    // legitimate login from 25 ms to 431 ms (17x), growing linearly. Bounded
    // rejection is a far better failure than unbounded latency, and it applies
    // to every caller equally, so it opens no enumeration difference.
    if (_queue.length >= _maxQueue) {
        var err = new Error('[gina authn] password-hashing queue is full (' + _maxQueue + ' waiting) — shedding load. Respond 503 and retry; if this is steady-state, the login endpoint needs request-rate limiting in front of it.');
        err.code = 'AUTHN_QUEUE_FULL';
        if (typeof onRejected === 'function') {
            return process.nextTick(function () { onRejected(err); });
        }
        throw err;
    }
    _queue.push(start);
}

/**
 * Set the scrypt concurrency ceiling.
 *
 * Raise it only alongside a matching threadpool size (`UV_THREADPOOL_SIZE`) and
 * a memory budget. The peak is `maxConcurrent` times the working set of the
 * parameters actually in use — 128 MiB each at the shipped defaults, but up to
 * the `MAX_WORKING_SET_MIB` ceiling for a stored hash carrying a higher `r`,
 * since a stored hash chooses its own cost.
 *
 * @param {number} n - positive integer.
 * @returns {void}
 * @throws {Error} when `n` is not a positive integer.
 * @memberof module:lib/authn
 *
 * @example
 * lib.authn.setMaxConcurrentHashes(4); // needs UV_THREADPOOL_SIZE >= 6 and ~512 MiB headroom
 */
function setMaxConcurrentHashes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 1 || Math.floor(n) !== n) {
        throw new Error('[gina authn] setMaxConcurrentHashes(n) expects a positive integer — got: ' + JSON.stringify(n));
    }
    _maxConcurrent = n;
    while (_inFlight < _maxConcurrent && _queue.length > 0) {
        var next = _queue.shift();
        next();
    }
}

/**
 * Minimum accepted lengths, in bytes, for the SALT and KEY fields of a stored
 * hash.
 *
 * A stored hash is attacker-controlled once the credential store is — and it is
 * also whatever a bad migration or a truncated column left behind. Since
 * {@link verifyPassword} derives exactly as many bytes as the stored key holds,
 * a SHORT key silently weakens the comparison to that many bytes: measured, a
 * 1-byte stored key authenticated 1 of 60 random passwords. Anything below
 * these floors was not minted here, so it is rejected rather than compared.
 *
 * @constant
 * @type {number}
 * @inner
 * @private
 */
var MIN_STORED_KEY_BYTES = 16;

/**
 * Accepted ranges for the cost parameters, and the ceiling on the working set
 * they imply.
 *
 * Bounding each parameter INDEPENDENTLY is not enough: scrypt's working set is
 * `128 * 2^ln * r`, so the corner of the allowed box — `ln=20, r=32` — implies
 * **4 GiB per verify**, 32x the documented peak, from a stored string an
 * attacker controls once the credential store does. `p` multiplies CPU rather
 * than memory (measured: `p=16` cost 14x the wall time of `p=1` at the same
 * memory), so it is bounded separately and tightly — we mint `p=1`.
 *
 * `MAX_WORKING_SET_MIB` is set so the whole documented mint range stays legal at
 * the standard `r=8` (`ln=20, r=8` is exactly 1024 MiB) while the pathological
 * corners are refused.
 *
 * @constant
 * @inner
 * @private
 */
var PARAM_BOUNDS = { lnMin: 14, lnMax: 20, rMin: 1, rMax: 32, pMin: 1, pMax: 4 };
/** @constant {number} Ceiling on `128 * 2^ln * r`, in MiB. @inner @private */
var MAX_WORKING_SET_MIB = 1024;

/**
 * Validate a cost triple against the shared bounds AND the working-set ceiling.
 *
 * Applied identically when minting and when reading a stored hash — an
 * asymmetry between the two is how {@link hashPassword} was able to mint hashes
 * {@link verifyPassword} could never read.
 *
 * @param {number} ln
 * @param {number} r
 * @param {number} p
 * @returns {boolean}
 * @inner
 * @private
 */
function costWithinBounds(ln, r, p) {
    if (!isFinite(ln) || !isFinite(r) || !isFinite(p)) {
        return false;
    }
    if (Math.floor(ln) !== ln || Math.floor(r) !== r || Math.floor(p) !== p) {
        return false;
    }
    if (ln < PARAM_BOUNDS.lnMin || ln > PARAM_BOUNDS.lnMax) {
        return false;
    }
    if (r < PARAM_BOUNDS.rMin || r > PARAM_BOUNDS.rMax) {
        return false;
    }
    if (p < PARAM_BOUNDS.pMin || p > PARAM_BOUNDS.pMax) {
        return false;
    }
    return (128 * Math.pow(2, ln) * r) / (1024 * 1024) <= MAX_WORKING_SET_MIB;
}
/** @constant {number} Minimum stored salt length in bytes. @inner @private */
var MIN_STORED_SALT_BYTES = 8;

/**
 * Normalise a password to Unicode NFC.
 *
 * The same accented character has more than one valid encoding — `é` as a
 * single code point, or `e` followed by a combining acute. A keyboard, an
 * operating system and a browser can each produce a different one, so a user
 * who registers on one device and signs in from another otherwise submits
 * bytes that will never match, and is locked out of their own account with no
 * explanation. Normalising both sides of the comparison removes that.
 *
 * @param {string} password
 * @returns {string}
 * @inner
 * @private
 */
function normalizePassword(password) {
    return password.normalize('NFC');
}

/**
 * Reject anything that is not a usable password string.
 *
 * The byte cap is applied AFTER normalisation, since normalising can change the
 * encoded length.
 *
 * @param {*} password
 * @returns {?Error} the error, or `null` when acceptable.
 * @inner
 * @private
 */
function checkPasswordInput(password) {
    if (typeof password !== 'string') {
        return new Error('[gina authn] password must be a string — got: ' + (password === null ? 'null' : typeof password));
    }
    if (password.length === 0) {
        return new Error('[gina authn] password must not be empty');
    }
    if (Buffer.byteLength(normalizePassword(password), 'utf8') > MAX_PASSWORD_BYTES) {
        return new Error('[gina authn] password exceeds ' + MAX_PASSWORD_BYTES + ' bytes — reject it in your form validation before hashing');
    }
    return null;
}

/**
 * base64 without padding, for PHC fields.
 *
 * @param {Buffer} buf
 * @returns {string}
 * @inner
 * @private
 */
function b64(buf) {
    return buf.toString('base64').replace(/=+$/, '');
}

/**
 * Hash a password, producing a self-describing PHC string.
 *
 * Asynchronous by construction — there is no synchronous variant, because the
 * work is ~100 ms and a sync KDF on the request path blocks the event loop for
 * every other connection.
 *
 * The returned string is what you persist. It embeds the algorithm, the cost
 * parameters and the salt, so nothing else needs storing and the parameters can
 * be raised later without invalidating it.
 *
 * @param {string}   password    - plaintext; 1..1024 bytes UTF-8.
 * @param {object}   [options]   - overrides.
 * @param {number}   [options.ln=17] - base-2 log of scrypt N (14..20).
 * @param {number}   [options.r=8]   - block size.
 * @param {number}   [options.p=1]   - parallelism.
 * @param {function} cb          - `cb(err, phcString)`. `err.code` is
 *   `AUTHN_QUEUE_FULL` when the hashing queue is shedding load — respond 503.
 * @returns {void}
 * @memberof module:lib/authn
 *
 * @example
 * lib.authn.hashPassword('correct horse battery staple', function (err, hash) {
 *     // hash === '$scrypt$ln=17,r=8,p=1$<salt>$<key>'  -> store it
 * });
 *
 * @example <caption>Lower cost in a test suite</caption>
 * lib.authn.hashPassword(pw, { ln: 12 }, function (err, hash) { });
 */
function hashPassword(password, options, cb) {
    if (typeof options === 'function') {
        cb = options;
        options = {};
    }
    if (typeof cb !== 'function') {
        throw new Error('[gina authn] hashPassword(password[, options], cb) requires a callback function');
    }
    options = options || {};

    var inputErr = checkPasswordInput(password);
    if (inputErr) {
        return process.nextTick(function () { cb(inputErr); });
    }

    var ln = (typeof options.ln === 'number') ? options.ln : SCRYPT_PARAMS.ln;
    var r  = (typeof options.r === 'number')  ? options.r  : SCRYPT_PARAMS.r;
    var p  = (typeof options.p === 'number')  ? options.p  : SCRYPT_PARAMS.p;

    // Exactly the bounds parseScryptPhc enforces. They were once looser here —
    // `r` and `p` had no upper bound while the parser capped them — so
    // hashPassword happily minted hashes verifyPassword could not read, and the
    // CORRECT password then reported "wrong password" forever, with no error
    // anywhere: a silent permanent lockout. Measured with r=64.
    if (!costWithinBounds(ln, r, p)) {
        return process.nextTick(function () {
            cb(new Error('[gina authn] hashPassword: cost out of range — `ln` '
                + PARAM_BOUNDS.lnMin + '..' + PARAM_BOUNDS.lnMax
                + ', `r` ' + PARAM_BOUNDS.rMin + '..' + PARAM_BOUNDS.rMax
                + ', `p` ' + PARAM_BOUNDS.pMin + '..' + PARAM_BOUNDS.pMax
                + ', and 128 * 2^ln * r must not exceed ' + MAX_WORKING_SET_MIB + ' MiB'
                + ' — got: ln=' + JSON.stringify(ln) + ', r=' + JSON.stringify(r) + ', p=' + JSON.stringify(p)));
        });
    }

    var salt = crypto.randomBytes(SALT_BYTES);
    var N    = Math.pow(2, ln);
    var pw   = normalizePassword(password);

    withSlot(function (release) {
        // node's default maxmem (32 MiB) is below what these parameters need, so
        // it must be raised explicitly or scrypt throws. 128 * N * r is the
        // documented working-set formula; the headroom multiplier covers node's
        // own bookkeeping.
        var maxmem = 128 * N * r * 2;
        crypto.scrypt(pw, salt, KEY_BYTES, { N: N, r: r, p: p, maxmem: maxmem }, function (err, derived) {
            release();
            if (err) {
                return cb(err);
            }
            cb(null, '$scrypt$ln=' + ln + ',r=' + r + ',p=' + p + '$' + b64(salt) + '$' + b64(derived));
        });
    }, cb);
}

/**
 * Parse a gina scrypt PHC string.
 *
 * @param {string} stored
 * @returns {?{ln: number, r: number, p: number, salt: Buffer, hash: Buffer}} `null` when the string is not a well-formed gina scrypt hash.
 * @inner
 * @private
 */
function parseScryptPhc(stored) {
    if (typeof stored !== 'string') {
        return null;
    }
    var m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
    if (!m) {
        return null;
    }
    var ln = parseInt(m[1], 10);
    var r  = parseInt(m[2], 10);
    var p  = parseInt(m[3], 10);
    // A stored hash is attacker-controlled the moment the credential store is.
    // Unbounded parameters here would let a single verify allocate arbitrary
    // memory — the same DoS the input cap closes from the other side.
    if (!costWithinBounds(ln, r, p)) {
        return null;
    }
    var salt = Buffer.from(m[4], 'base64');
    var hash = Buffer.from(m[5], 'base64');
    // Length floors, not merely non-emptiness: verifyPassword derives exactly
    // `hash.length` bytes, so a short stored key shrinks the comparison to that
    // width. Measured before this guard: a 1-byte key authenticated 1 of 60
    // random passwords. We mint 32/16, so anything below these floors is
    // corruption or forgery either way.
    if (salt.length < MIN_STORED_SALT_BYTES || hash.length < MIN_STORED_KEY_BYTES) {
        return null;
    }
    return { ln: ln, r: r, p: p, salt: salt, hash: hash };
}

/**
 * Resolve an optional verifier package from the consuming project.
 *
 * Same project-path resolution every gina connector uses for its driver — the
 * package belongs to the bundle, not the framework.
 *
 * @param {string} pkg - `'argon2'` or `'bcrypt'`.
 * @returns {?object} the module, or `null` when not installed.
 * @inner
 * @private
 */
function resolveVerifier(pkg) {
    if (_injectedVerifiers[pkg]) {
        return _injectedVerifiers[pkg];
    }
    try {
        var p = _(getPath('project') + '/node_modules/' + pkg, true);
        return require(p);
    } catch (e) {
        return null;
    }
}

/** @type {object} Test-injected verifier modules. @inner @private */
var _injectedVerifiers = {};

/**
 * Inject a verifier module, bypassing project-path resolution.
 *
 * Test seam — mirrors `lib/metrics`' `opts.client`. Not part of the supported
 * surface.
 *
 * @param {string}  pkg - `'argon2'` or `'bcrypt'`.
 * @param {?object} mod - the module, or `null` to clear.
 * @returns {void}
 * @memberof module:lib/authn
 * @private
 */
function _setVerifier(pkg, mod) {
    if (mod === null) {
        delete _injectedVerifiers[pkg];
        return;
    }
    _injectedVerifiers[pkg] = mod;
}

/**
 * Verify a password against a stored hash.
 *
 * Accepts gina's own `$scrypt$` hashes, and — through the consuming project's
 * own `argon2` / `bcrypt` install — `$argon2i$` / `$argon2d$` / `$argon2id$`
 * and `$2a$` / `$2b$` / `$2y$`. That foreign-format branch exists so a bundle
 * arriving with existing hashes keeps working; pair it with {@link needsRehash}
 * to migrate on login.
 *
 * **Never throws for a bad password.** A malformed or unrecognised stored hash
 * is `cb(null, false)`, not an error — a corrupted record must not be
 * distinguishable from a wrong password by an attacker watching responses. A
 * genuine operational failure (KDF error, verifier package missing for a format
 * that needs one) IS an error, because it needs an operator, not a login form.
 *
 * @param {string}   password - plaintext to check.
 * @param {string}   stored   - the persisted hash string.
 * @param {function} cb       - `cb(err, isValid)`. `err.code` is
 *   `AUTHN_QUEUE_FULL` when the hashing queue is shedding load — respond 503,
 *   and treat the account-not-found branch identically (see {@link dummyVerify}).
 * @returns {void}
 * @memberof module:lib/authn
 *
 * @example
 * lib.authn.verifyPassword(submitted, account.passwordHash, function (err, ok) {
 *     if (err)  { return self.throwError(500); }  // operational
 *     if (!ok)  { return deny(); }                // wrong password
 * });
 *
 * @example <caption>Unknown account — spend the same time (see dummyVerify)</caption>
 * if (!account) {
 *     return lib.authn.dummyVerify(submitted, { like: referenceHash }, function () { deny(); });
 * }
 */
function verifyPassword(password, stored, cb) {
    if (typeof cb !== 'function') {
        throw new Error('[gina authn] verifyPassword(password, stored, cb) requires a callback function');
    }
    var inputErr = checkPasswordInput(password);
    if (inputErr) {
        return process.nextTick(function () { cb(inputErr); });
    }
    if (typeof stored !== 'string' || stored.length === 0) {
        return process.nextTick(function () { cb(null, false); });
    }

    if (/^\$argon2[id]{1,2}\$/.test(stored)) {
        var argon2 = resolveVerifier('argon2');
        if (!argon2 || typeof argon2.verify !== 'function') {
            return process.nextTick(function () {
                cb(new Error('[gina authn] this hash is argon2, which gina verifies through your project\'s own package. Run: npm install argon2'));
            });
        }
        return Promise.resolve()
            .then(function () { return argon2.verify(stored, normalizePassword(password)); })
            .then(function (ok) { cb(null, ok === true); })
            .catch(function () { cb(null, false); });
    }

    if (/^\$2[aby]\$/.test(stored)) {
        var bcrypt = resolveVerifier('bcrypt');
        if (!bcrypt || typeof bcrypt.compare !== 'function') {
            return process.nextTick(function () {
                cb(new Error('[gina authn] this hash is bcrypt, which gina verifies through your project\'s own package. Run: npm install bcrypt'));
            });
        }
        return bcrypt.compare(normalizePassword(password), stored, function (err, ok) {
            if (err) {
                return cb(null, false);
            }
            cb(null, ok === true);
        });
    }

    var parsed = parseScryptPhc(stored);
    if (!parsed) {
        return process.nextTick(function () { cb(null, false); });
    }

    var N = Math.pow(2, parsed.ln);
    var pwNorm = normalizePassword(password);
    withSlot(function (release) {
        var maxmem = 128 * N * parsed.r * 2;
        crypto.scrypt(pwNorm, parsed.salt, parsed.hash.length, { N: N, r: parsed.r, p: parsed.p, maxmem: maxmem }, function (err, derived) {
            release();
            if (err) {
                return cb(err);
            }
            // Lengths match by construction (derived is requested at the stored
            // length), so timingSafeEqual cannot throw here — the try/catch is
            // the house convention, and it keeps a future refactor fail-closed.
            var ok = false;
            try {
                ok = crypto.timingSafeEqual(derived, parsed.hash);
            } catch (e) {
                ok = false;
            }
            cb(null, ok);
        });
    }, cb);
}

/**
 * Spend a verify's worth of time without a stored hash.
 *
 * A login that returns instantly for an unknown account and slowly for a known
 * one is a user-enumeration oracle, and it is measurable across a network. Call
 * this on the account-not-found branch so both branches cost the same.
 *
 * **The cost must match the cost your stored hashes actually use**, and by
 * default that is the shipped parameters. If your hashes were minted cheaper —
 * a lowered `ln`, or legacy hashes not yet migrated by {@link needsRehash} —
 * pass the same parameters, or pass `like: <a stored hash>` and the cost is read
 * from it. Getting this wrong does not merely fail to close the oracle, it
 * INVERTS it: measured at defaults against `ln=14` hashes, the unknown-account
 * branch ran 13.9x SLOWER than the known-account one, which is a louder signal
 * than doing nothing.
 *
 * @param {string}          password  - the submitted plaintext.
 * @param {object|function} [options] - cost overrides, or the callback.
 * @param {string}          [options.like] - a stored hash to copy the cost from (wins over ln/r/p).
 * @param {number}          [options.ln=17]
 * @param {number}          [options.r=8]
 * @param {number}          [options.p=1]
 * @param {function}        cb        - `cb(err)`. `err` is `null` normally; it
 *   carries `AUTHN_QUEUE_FULL` when the hashing queue is shedding load. Handle
 *   it EXACTLY as you handle {@link verifyPassword}'s error — respond 503 —
 *   because any divergence between the two branches under saturation is the
 *   enumeration signal this function exists to remove.
 * @returns {void}
 * @memberof module:lib/authn
 *
 * @example <caption>Always pass a cost — `like` reads it from a real hash</caption>
 * if (!account) {
 *     // `referenceHash` is any hash from your store (seed one at install time).
 *     // Reading the cost from real data is what keeps the two branches matched
 *     // as you raise parameters — a separate setting silently drifts.
 *     return lib.authn.dummyVerify(self.post.password, { like: referenceHash }, function () {
 *         self.renderJSON({ error: 'invalid credentials' });
 *     });
 * }
 *
 * @example <caption>Or state the cost explicitly</caption>
 * lib.authn.dummyVerify(submitted, { ln: 14 }, function () { deny(); });
 */
function dummyVerify(password, options, cb) {
    if (typeof options === 'function') {
        cb = options;
        options = {};
    }
    if (typeof cb !== 'function') {
        throw new Error('[gina authn] dummyVerify(password[, options], cb) requires a callback function');
    }
    options = options || {};

    var ln = SCRYPT_PARAMS.ln;
    var r  = SCRYPT_PARAMS.r;
    var p  = SCRYPT_PARAMS.p;

    // `like` copies the cost off a real stored hash — the most reliable way to
    // stay matched, since it needs no separate configuration to keep in sync.
    if (typeof options.like === 'string') {
        var ref = parseScryptPhc(options.like);
        if (ref) {
            ln = ref.ln;
            r  = ref.r;
            p  = ref.p;
        }
    } else {
        if (typeof options.ln === 'number') { ln = options.ln; }
        if (typeof options.r === 'number')  { r  = options.r; }
        if (typeof options.p === 'number')  { p  = options.p; }
    }
    // Silently clamp rather than throw: this runs on a failed-login path, and an
    // exception there would turn a mistuned parameter into an outage.
    if (!isFinite(ln) || ln < 14 || ln > 20) { ln = SCRYPT_PARAMS.ln; }
    if (!isFinite(r) || r < 1 || r > 32)     { r  = SCRYPT_PARAMS.r; }
    if (!isFinite(p) || p < 1 || p > 16)     { p  = SCRYPT_PARAMS.p; }

    var pw = (typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES)
        ? normalizePassword(password)
        : 'x';
    var salt = crypto.randomBytes(SALT_BYTES);
    var N    = Math.pow(2, ln);
    withSlot(function (release) {
        var maxmem = 128 * N * r * 2;
        crypto.scrypt(pw, salt, KEY_BYTES, { N: N, r: r, p: p, maxmem: maxmem }, function () {
            release();
            cb(null);
        });
    }, function (err) {
        // Surface the shed error, because verifyPassword surfaces it too. If
        // this branch swallowed it, then under saturation a known account would
        // 500 while an unknown one returned "invalid credentials" — saturation
        // itself would become the enumeration signal this function exists to
        // remove. Both branches must look identical in every regime.
        cb(err);
    });
}

/**
 * Report whether a stored hash is below the current policy.
 *
 * True when the hash is not gina scrypt (a foreign argon2 / bcrypt hash, or an
 * unparseable string) or when its encoded parameters are weaker than the
 * current defaults. Re-hash on the next successful login — the one moment the
 * plaintext is available.
 *
 * @param {string} stored - the persisted hash string.
 * @returns {boolean}
 * @memberof module:lib/authn
 *
 * @example
 * if (ok && lib.authn.needsRehash(account.passwordHash)) {
 *     lib.authn.hashPassword(submitted, function (err, fresh) {
 *         if (!err) { account.passwordHash = fresh; account.save(); }
 *     });
 * }
 */
function needsRehash(stored) {
    var parsed = parseScryptPhc(stored);
    if (!parsed) {
        return true;
    }
    // A key shorter than we mint verifies at reduced width forever otherwise —
    // a record truncated by, say, a bcrypt-sized VARCHAR(60) parses (it clears
    // the 16-byte floor) and would never be flagged for migration.
    return parsed.hash.length !== KEY_BYTES
        || parsed.ln < SCRYPT_PARAMS.ln
        || parsed.r < SCRYPT_PARAMS.r
        || parsed.p < SCRYPT_PARAMS.p;
}

/**
 * Validate a password against a length / composition policy.
 *
 * Length-first, per NIST SP 800-63B: the default is a 12-character minimum with
 * NO character-class requirements, because mandatory composition measurably
 * degrades real-world password quality. Composition rules are available for
 * consumers whose auditor requires them.
 *
 * @param {string}   password  - the candidate.
 * @param {object}   [options] - policy overrides.
 * @param {number}   [options.minLength=12]      - minimum characters (code points, not bytes).
 * @param {number}   [options.maxLength=1024]    - maximum bytes of UTF-8.
 * @param {boolean}  [options.requireUppercase=false]
 * @param {boolean}  [options.requireLowercase=false]
 * @param {boolean}  [options.requireDigit=false]
 * @param {boolean}  [options.requireSymbol=false]
 * @param {string[]} [options.deny=[]]           - case-insensitive substrings to reject (the user's own email, the site name, …).
 * @returns {{valid: boolean, errors: string[]}} `errors` are stable machine-readable codes: `too-short`, `too-long`, `missing-uppercase`, `missing-lowercase`, `missing-digit`, `missing-symbol`, `denied-substring`, `not-a-string`.
 * @memberof module:lib/authn
 *
 * @example
 * var check = lib.authn.validatePasswordPolicy(self.post.password, {
 *     deny: [ self.post.email, 'gina' ]
 * });
 * if (!check.valid) { return self.renderJSON({ errors: check.errors }); }
 */
function validatePasswordPolicy(password, options) {
    options = options || {};
    var errors = [];

    if (typeof password !== 'string') {
        return { valid: false, errors: [ 'not-a-string' ] };
    }

    // Validated rather than trusted: `typeof NaN === 'number'`, so a
    // `parseInt` of a missing config key produced minLength NaN, every
    // comparison against it went false, and an EMPTY password passed the policy.
    // A negative minLength did the same. This is the one input in the module
    // that was taken on faith, and it fails OPEN.
    var minLength = DEFAULT_MIN_LENGTH;
    if (typeof options.minLength !== 'undefined') {
        if (typeof options.minLength !== 'number' || !isFinite(options.minLength)
            || options.minLength < 0 || Math.floor(options.minLength) !== options.minLength) {
            throw new Error('[gina authn] validatePasswordPolicy: `minLength` must be a whole number >= 0 — got: ' + JSON.stringify(options.minLength));
        }
        minLength = options.minLength;
    }
    var maxLength = MAX_PASSWORD_BYTES;
    if (typeof options.maxLength !== 'undefined') {
        if (typeof options.maxLength !== 'number' || !isFinite(options.maxLength)
            || options.maxLength < 1 || Math.floor(options.maxLength) !== options.maxLength) {
            throw new Error('[gina authn] validatePasswordPolicy: `maxLength` must be a whole number >= 1 — got: ' + JSON.stringify(options.maxLength));
        }
        maxLength = options.maxLength;
    }

    // Byte length FIRST, and return on breach: `Array.from` materialises an
    // array of code points, so measuring length before enforcing the cap meant
    // a 16 MiB submission allocated ~144 MiB just to conclude "too long".
    if (Buffer.byteLength(password, 'utf8') > maxLength) {
        return { valid: false, errors: [ 'too-long' ] };
    }

    // Count code points, not UTF-16 units, so an emoji or an astral character
    // counts once rather than twice. NOTE this counts CODE POINTS, not grapheme
    // clusters: a family emoji is one perceived character but several code
    // points, so `minLength` is a floor on code points and can overstate
    // strength for grapheme-rich input.
    var length = Array.from(password).length;
    if (length < minLength) {
        errors.push('too-short');
    }
    if (options.requireUppercase === true && !/[A-Z]/.test(password)) {
        errors.push('missing-uppercase');
    }
    if (options.requireLowercase === true && !/[a-z]/.test(password)) {
        errors.push('missing-lowercase');
    }
    if (options.requireDigit === true && !/[0-9]/.test(password)) {
        errors.push('missing-digit');
    }
    if (options.requireSymbol === true && !/[^A-Za-z0-9]/.test(password)) {
        errors.push('missing-symbol');
    }
    if (Array.isArray(options.deny) && options.deny.length > 0) {
        var lower = password.toLowerCase();
        for (var i = 0; i < options.deny.length; i++) {
            var needle = options.deny[i];
            if (typeof needle === 'string' && needle.length > 0 && lower.indexOf(needle.toLowerCase()) > -1) {
                errors.push('denied-substring');
                break;
            }
        }
    }

    return { valid: errors.length === 0, errors: errors };
}

module.exports = {
    hashPassword            : hashPassword,
    verifyPassword          : verifyPassword,
    dummyVerify             : dummyVerify,
    needsRehash             : needsRehash,
    validatePasswordPolicy  : validatePasswordPolicy,
    setMaxConcurrentHashes  : setMaxConcurrentHashes,
    createLockout           : lockout.createLockout,
    generateTotpSecret      : totp.generateTotpSecret,
    generateTotp            : totp.generateTotp,
    verifyTotp              : totp.verifyTotp,
    otpauthURL              : totp.otpauthURL,
    // test seams — may change without notice
    _base32Encode           : totp._base32Encode,
    _base32Decode           : totp._base32Decode,
    _hotp                   : totp._hotp,
    _createMemoryStore      : lockout._createMemoryStore,
    _DEFAULT_MAX_ATTEMPTS   : lockout._DEFAULT_MAX_ATTEMPTS,
    _DEFAULT_LOCK_MS        : lockout._DEFAULT_LOCK_MS,
    _parseScryptPhc         : parseScryptPhc,
    _setVerifier            : _setVerifier,
    _SCRYPT_PARAMS          : SCRYPT_PARAMS,
    _MAX_PASSWORD_BYTES     : MAX_PASSWORD_BYTES,
    _DEFAULT_MIN_LENGTH     : DEFAULT_MIN_LENGTH
};
