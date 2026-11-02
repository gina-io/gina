/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module money
 *
 * Exact-money primitive (#FIN5) — ISO 4217 minor-unit integer arithmetic,
 * BigInt-safe, dependency-free, dual-context (server + browser bundle).
 *
 * The one rule this module exists to enforce: an amount of money is an
 * INTEGER count of a currency's minor units (cents, fils, yen...), never an
 * IEEE 754 float. `0.10 + 0.20` is wrong out of the box in JavaScript; this
 * module makes the correct pattern cheap:
 *
 *   wire (string, byte-exact)  ->  parse()  ->  { minor: BigInt }  ->  arithmetic
 *                                                        |
 *   wire (string)              <-  format() / toMinor()  <
 *
 * What it deliberately does NOT do:
 *  - Display formatting (locale symbols, grouping): that is the i18n layer's
 *    job — `Intl.NumberFormat(culture, { style: 'currency', currency: code })`
 *    is native on both runtimes. `format()` here returns the CANONICAL wire
 *    string ("1234.50"), locale-independent.
 *  - Rounding policy: `parse()` REJECTS excess precision instead of rounding
 *    (whether "1.005" rounds up, down or banker's is application domain), and
 *    `multiply()` accepts INTEGER factors only for the same reason. An
 *    application that needs fractional factors owns its rounding explicitly,
 *    on minor units.
 *  - Currency conversion: rates are application data.
 *
 * Amounts internally use BigInt so totals beyond `Number.MAX_SAFE_INTEGER`
 * minor units stay exact. BigInt values are created exclusively through the
 * `BigInt()` constructor — no BigInt literals — so the source stays parseable
 * by every tool in the browser-bundle build chain.
 *
 * @example
 *  var money = require('lib/money'); // server: bare module | browser: gina.money
 *  var a = money.parse('19.99', 'EUR');
 *  var b = money.parse('0.01',  'EUR');
 *  money.format(money.add(a, b));      // '20.00'
 *  money.toMinor(money.add(a, b));     // '2000'
 *  money.parse('100', 'JPY').exponent; // 0 — no minor unit
 *  money.add(a, money.parse('1', 'USD')); // throws TypeError (currency mismatch)
 * */

var Money = (function() {

    var self = {};

    /**
     * ISO 4217 minor-unit exponents that differ from the default of 2.
     * Sourced from the ISO 4217 active-currency table; funds and precious-
     * metal codes (XAU, XDR, ...) carry no minor unit and are not listed —
     * they resolve to the default like any unlisted well-formed code.
     *
     * @constant
     * @type {Object<string, number>}
     * @inner
     * */
    var EXPONENT_EXCEPTIONS = {
        // 0 — no minor unit
        'BIF': 0, 'CLP': 0, 'DJF': 0, 'GNF': 0, 'ISK': 0, 'JPY': 0,
        'KMF': 0, 'KRW': 0, 'PYG': 0, 'RWF': 0, 'UGX': 0, 'UYI': 0,
        'VND': 0, 'VUV': 0, 'XAF': 0, 'XOF': 0, 'XPF': 0,
        // 3 — mills
        'BHD': 3, 'IQD': 3, 'JOD': 3, 'KWD': 3, 'LYD': 3, 'OMR': 3, 'TND': 3,
        // 4
        'CLF': 4, 'UYW': 4
    };

    /**
     * Wire-amount shape: an optional sign, an integer part, an optional
     * fraction. Nothing else — no grouping separators, no exponent notation,
     * no currency symbols (those are display concerns).
     *
     * @constant
     * @inner
     * */
    var RE_AMOUNT   = /^(-?)(\d+)(?:\.(\d+))?$/;

    /**
     * Well-formed ISO 4217 alphabetic code.
     *
     * @constant
     * @inner
     * */
    var RE_CODE     = /^[A-Za-z]{3}$/;

    /**
     * Normalizes and validates a currency code.
     *
     * @inner
     * @param {string} code - ISO 4217 alphabetic code, any case
     * @returns {string} the upper-cased code
     * @throws {TypeError} when `code` is not a 3-letter string
     * */
    var normalizeCode = function(code) {
        if ( typeof(code) != 'string' || !RE_CODE.test(code) ) {
            throw new TypeError('[ money ] invalid currency code: expected a 3-letter ISO 4217 code, got `' + code + '`');
        }
        return code.toUpperCase();
    };

    /**
     * Asserts a value is a money amount produced by this module.
     *
     * @inner
     * @param {object} a
     * @returns {object} `a`
     * @throws {TypeError} when the shape is not a money amount
     * */
    var assertAmount = function(a) {
        if ( !a || typeof(a) != 'object' || typeof(a.minor) != 'bigint' || typeof(a.currency) != 'string' ) {
            throw new TypeError('[ money ] not a money amount: expected the { currency, exponent, minor } shape from parse()/fromMinor()');
        }
        return a;
    };

    /**
     * Asserts two amounts share one currency.
     *
     * @inner
     * @param {object} a
     * @param {object} b
     * @throws {TypeError} on a currency mismatch — mixed-currency arithmetic
     *  is the corruption this module exists to prevent, so it always throws
     * */
    var assertSameCurrency = function(a, b) {
        assertAmount(a); assertAmount(b);
        if (a.currency !== b.currency) {
            throw new TypeError('[ money ] currency mismatch: `' + a.currency + '` vs `' + b.currency + '` — convert explicitly before operating');
        }
    };

    /**
     * Returns the minor-unit exponent for a currency.
     * Unlisted well-formed codes resolve to the ISO default of 2.
     *
     * @param {string} code - ISO 4217 alphabetic code, any case
     * @returns {number} 0, 2, 3 or 4
     * @throws {TypeError} when `code` is not a 3-letter string
     *
     * @example
     *  money.exponent('EUR'); // 2
     *  money.exponent('jpy'); // 0
     *  money.exponent('BHD'); // 3
     * */
    self.exponent = function(code) {
        code = normalizeCode(code);
        return ( typeof(EXPONENT_EXCEPTIONS[code]) != 'undefined' ) ? EXPONENT_EXCEPTIONS[code] : 2;
    };

    /**
     * Parses a canonical wire string into an exact amount.
     *
     * The input is the decimal string an API carries on the wire (`"19.99"`,
     * `"-0.05"`, `"1234"`). Excess fractional digits are an ERROR, not a
     * rounding opportunity: `parse('1.005', 'EUR')` throws.
     *
     * @param {string} value - decimal string; sign + digits + optional fraction
     * @param {string} code - ISO 4217 alphabetic code, any case
     * @returns {{currency: string, exponent: number, minor: bigint}}
     * @throws {TypeError} on a non-string / malformed value, a malformed
     *  code, or more fractional digits than the currency's exponent
     *
     * @example
     *  money.parse('19.99', 'EUR');  // { currency:'EUR', exponent:2, minor: 1999n }
     *  money.parse('19.9',  'EUR');  // minor 1990n — short fractions scale up
     *  money.parse('100',   'JPY');  // { currency:'JPY', exponent:0, minor: 100n }
     *  money.parse('1.005', 'EUR');  // throws — precision beyond the exponent
     *  money.parse(19.99,   'EUR');  // throws — floats are the hazard, not an input
     * */
    self.parse = function(value, code) {
        code = normalizeCode(code);
        if ( typeof(value) != 'string' ) {
            throw new TypeError('[ money ] parse() takes the WIRE STRING, not a number — a float has already lost exactness (`' + value + '`)');
        }
        var m = RE_AMOUNT.exec(value.trim());
        if (!m) {
            throw new TypeError('[ money ] malformed amount `' + value + '`: expected digits with an optional sign and `.` fraction');
        }
        var exp      = self.exponent(code);
        var fraction = m[3] || '';
        if (fraction.length > exp) {
            throw new TypeError('[ money ] `' + value + '` carries ' + fraction.length + ' fractional digit(s) but ' + code + ' has ' + exp + ' — rounding is the application\'s decision, apply it before parse()');
        }
        while (fraction.length < exp) {
            fraction += '0';
        }
        var minor = BigInt(m[2] + fraction);
        if (m[1] === '-') {
            minor = -minor;
        }
        return { currency: code, exponent: exp, minor: minor };
    };

    /**
     * Builds an amount directly from a minor-unit count.
     *
     * @param {string|number|bigint} minor - integer minor units (`1999`, `'1999'`)
     * @param {string} code - ISO 4217 alphabetic code, any case
     * @returns {{currency: string, exponent: number, minor: bigint}}
     * @throws {TypeError} on a malformed code, a non-integer number, or a
     *  string that is not a plain signed integer
     *
     * @example
     *  money.fromMinor(1999, 'EUR');   // 19.99 EUR
     *  money.fromMinor('250', 'JPY');  // 250 JPY
     * */
    self.fromMinor = function(minor, code) {
        code = normalizeCode(code);
        var big;
        if ( typeof(minor) == 'bigint' ) {
            big = minor;
        } else if ( typeof(minor) == 'number' ) {
            if ( !isFinite(minor) || Math.floor(minor) !== minor ) {
                throw new TypeError('[ money ] fromMinor() takes an INTEGER minor-unit count, got `' + minor + '`');
            }
            big = BigInt(minor);
        } else if ( typeof(minor) == 'string' && /^-?\d+$/.test(minor.trim()) ) {
            big = BigInt(minor.trim());
        } else {
            throw new TypeError('[ money ] fromMinor() takes an integer as bigint, number or string, got `' + minor + '`');
        }
        return { currency: code, exponent: self.exponent(code), minor: big };
    };

    /**
     * Exact addition. Same-currency only.
     *
     * @param {object} a - amount from parse()/fromMinor()
     * @param {object} b - amount from parse()/fromMinor()
     * @returns {{currency: string, exponent: number, minor: bigint}}
     * @throws {TypeError} on a currency mismatch or a non-amount
     *
     * @example
     *  money.format(money.add(money.parse('0.10','EUR'), money.parse('0.20','EUR'))); // '0.30'
     * */
    self.add = function(a, b) {
        assertSameCurrency(a, b);
        return { currency: a.currency, exponent: a.exponent, minor: a.minor + b.minor };
    };

    /**
     * Exact subtraction (`a - b`). Same-currency only.
     *
     * @param {object} a - amount from parse()/fromMinor()
     * @param {object} b - amount from parse()/fromMinor()
     * @returns {{currency: string, exponent: number, minor: bigint}}
     * @throws {TypeError} on a currency mismatch or a non-amount
     * */
    self.subtract = function(a, b) {
        assertSameCurrency(a, b);
        return { currency: a.currency, exponent: a.exponent, minor: a.minor - b.minor };
    };

    /**
     * Exact multiplication by an INTEGER factor (a quantity, a line count).
     * A fractional factor (a rate, a percentage) needs a rounding decision
     * the application owns — apply it on minor units, then fromMinor().
     *
     * @param {object} a - amount from parse()/fromMinor()
     * @param {string|number|bigint} factor - integer multiplier
     * @returns {{currency: string, exponent: number, minor: bigint}}
     * @throws {TypeError} on a non-amount or a non-integer factor
     *
     * @example
     *  money.format(money.multiply(money.parse('19.99','EUR'), 3)); // '59.97'
     * */
    self.multiply = function(a, factor) {
        assertAmount(a);
        var big;
        if ( typeof(factor) == 'bigint' ) {
            big = factor;
        } else if ( typeof(factor) == 'number' && isFinite(factor) && Math.floor(factor) === factor ) {
            big = BigInt(factor);
        } else if ( typeof(factor) == 'string' && /^-?\d+$/.test(factor.trim()) ) {
            big = BigInt(factor.trim());
        } else {
            throw new TypeError('[ money ] multiply() takes an INTEGER factor, got `' + factor + '` — a fractional rate needs the application\'s own rounding, on minor units');
        }
        return { currency: a.currency, exponent: a.exponent, minor: a.minor * big };
    };

    /**
     * Three-way comparison. Same-currency only.
     *
     * @param {object} a - amount from parse()/fromMinor()
     * @param {object} b - amount from parse()/fromMinor()
     * @returns {number} -1 when a < b, 0 when equal, 1 when a > b
     * @throws {TypeError} on a currency mismatch or a non-amount
     * */
    self.compare = function(a, b) {
        assertSameCurrency(a, b);
        if (a.minor < b.minor) { return -1; }
        if (a.minor > b.minor) { return 1; }
        return 0;
    };

    /**
     * Renders the canonical wire string: sign, integer part, and EXACTLY the
     * currency's exponent in fractional digits (`'20.00'`, `'-0.05'`, `'150'`
     * for a 0-exponent currency). Locale display belongs to the i18n layer
     * (`Intl.NumberFormat`); this string is for wires, stores and logs.
     *
     * @param {object} a - amount from parse()/fromMinor()
     * @returns {string}
     * @throws {TypeError} on a non-amount
     *
     * @example
     *  money.format(money.fromMinor(-5, 'EUR'));  // '-0.05'
     *  money.format(money.fromMinor(150, 'JPY')); // '150'
     * */
    self.format = function(a) {
        assertAmount(a);
        var neg   = a.minor < BigInt(0);
        var s     = (neg ? -a.minor : a.minor).toString();
        if (a.exponent === 0) {
            return (neg ? '-' : '') + s;
        }
        while (s.length <= a.exponent) {
            s = '0' + s;
        }
        var cut = s.length - a.exponent;
        return (neg ? '-' : '') + s.substring(0, cut) + '.' + s.substring(cut);
    };

    /**
     * Returns the minor-unit count as a JSON-safe decimal string.
     *
     * @param {object} a - amount from parse()/fromMinor()
     * @returns {string} e.g. `'1999'`, `'-5'`
     * @throws {TypeError} on a non-amount
     * */
    self.toMinor = function(a) {
        assertAmount(a);
        return a.minor.toString();
    };

    return self;

})();

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Money
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function() { return Money })
}
