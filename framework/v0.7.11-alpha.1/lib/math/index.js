//'use strict';
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs          = require('fs');
var console     = require('../logger');
var crypto      = require('crypto');

/**
 * MathHelper
 *
 * @package     gina.lib.math
 * @author      Rhinostone <contact@gina.io>
 * @api public
 * */

function MathHelper() {

    var self = this;

    // /**
    //  * init
    //  * @constructor
    //  * */
    // var init = function() {
    //     if ( typeof(Math.instance) != "undefined" ) {
    //         return Math.instance
    //     } else {
    //         Math.instance = self
    //     }
    // }

    /**
     * Operate from a string value.
     *
     * Evaluates an arithmetic expression without using `eval` or `new Function`:
     * supported operators are `+`, `-`, `*`, `/`, `%`, parentheses, decimals,
     * and unary `+` / `-`. Any non-arithmetic character throws.
     *
     * e.g.:
     *
     *  var operate = require("gina").lib.math.operate;
     *  var computation = "10*2";
     *  var result = operate(computation);
     *      => 20
     *
     *  @param {string} computation
     *
     *  @returns {number} result
     *  @throws {Error} when the expression contains an invalid character or is malformed
     * */
    // #SCS1 (2026-04-23) — replaced `new Function('return '+ computation)()` with a shunting-yard
    //                       evaluator so Socket no longer flags `Uses eval` here. Same public
    //                       contract (string expression → number); now rejects any non-arithmetic
    //                       character instead of silently running arbitrary JS. Old body kept for
    //                       reference:
    //
    //     self.operate = function(computation) {
    //         return new Function('return ' + computation)();
    //     };
    self.operate = function(computation) {
        var input  = String(computation);
        var output = [];
        var ops    = [];
        var prec   = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, 'u-': 3, 'u+': 3 };
        var apply  = function(op) {
            if (op === 'u+') { return; }
            if (op === 'u-') {
                if (!output.length) { throw new Error('MathHelper.operate: malformed expression'); }
                output.push(-output.pop());
                return;
            }
            var b = output.pop();
            var a = output.pop();
            if (typeof a === 'undefined' || typeof b === 'undefined') {
                throw new Error('MathHelper.operate: malformed expression');
            }
            if (op === '+') { output.push(a + b); }
            else if (op === '-') { output.push(a - b); }
            else if (op === '*') { output.push(a * b); }
            else if (op === '/') { output.push(a / b); }
            else if (op === '%') { output.push(a % b); }
        };

        var prev = 'op';
        var i = 0;
        while (i < input.length) {
            var c = input[i];
            if (/\s/.test(c)) { ++i; continue; }
            if (/\d/.test(c) || (c === '.' && /\d/.test(input[i + 1]))) {
                var num = '';
                var hasDot = false;
                while (i < input.length && /[\d.]/.test(input[i])) {
                    if (input[i] === '.') {
                        if (hasDot) { throw new Error('MathHelper.operate: invalid number literal'); }
                        hasDot = true;
                    }
                    num += input[i++];
                }
                output.push(parseFloat(num));
                prev = 'num';
                continue;
            }
            if (c === '(') { ops.push(c); prev = 'op'; ++i; continue; }
            if (c === ')') {
                while (ops.length && ops[ops.length - 1] !== '(') { apply(ops.pop()); }
                if (!ops.length) { throw new Error('MathHelper.operate: mismatched parenthesis'); }
                ops.pop();
                prev = 'num';
                ++i;
                continue;
            }
            if (/[+\-*/%]/.test(c)) {
                var op = c;
                if ((op === '-' || op === '+') && prev === 'op') { op = 'u' + op; }
                while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[op]) {
                    apply(ops.pop());
                }
                ops.push(op);
                prev = 'op';
                ++i;
                continue;
            }
            throw new Error('MathHelper.operate: invalid character `' + c + '`');
        }
        while (ops.length) {
            var tail = ops.pop();
            if (tail === '(') { throw new Error('MathHelper.operate: mismatched parenthesis'); }
            apply(tail);
        }
        if (output.length !== 1) { throw new Error('MathHelper.operate: malformed expression'); }
        return output[0];
    };

    /**
     * Checksum
     * e.g: checksum(data, 'sha1')
     *
     * @param {string} str - Data to analyse
     * @param {string} algorithm
     * @param {string} [ encoding ] - e.g.: hex
     *
     * @returns {string} checksum
     * */
    var checkSum = function (str, algorithm, encoding) {
        try {
            return crypto
                .createHash(algorithm || 'md5')
                .update(str, 'utf8')
                .digest(encoding || 'hex');
        } catch (err) {
            return err;
        }
    };

    /**
     * Checksum
     *
     * @param {string} filename|data
     * @param {string} algorithm
     * @param {string} encoding
     *
     * @callback cb
     *  @param {object|string} err
     *  @param {string} checksum
     * */
    self.checkSum = async function(filename, algorithm, encoding, isCheckingFromData, cb) {
        var err = false, sum = null;
        isCheckingFromData = ( typeof(isCheckingFromData) != 'undefined' ) ? isCheckingFromData : false;

        if ( !isCheckingFromData && /\./.test(filename) ) {
            fs.readFile(filename, async function (err, data) {
                sum = await checkSum(data, algorithm, encoding);
                if( sum instanceof Error) {
                    err = sum;
                    sum = undefined;
                }

                cb(err, sum);
            })
        } else {
            sum = await checkSum(filename, algorithm, encoding);
            if( sum instanceof Error) {
                err = sum;
                sum = undefined;
            }

            cb(err, sum);
        }
    }

    /**
     * Serialize an object or array into a stable string for checksumming.
     *
     * Plain objects become sorted `key:value` pairs joined with `,` (function
     * properties skipped); arrays become the JSON of a sorted copy. Both forms
     * are member-order-insensitive, and the input is never mutated.
     *
     * @private
     * @param {object|array} obj
     * @returns {string} serialized form
     * */
    var objectToString = function(obj) {
        var str = '';
        if (Array.isArray(obj)) {
            // #B208 — serialize a sorted COPY into `str`: the previous assignment
            // targeted `obj` and returned the still-empty `str`, collapsing every
            // array input to the checksum of '' — and `sort()` mutated the caller's array.
            str = JSON.stringify(obj.slice().sort(), null, 0);
        } else {
            var arr = [], i = 0;
            for (let k in obj) {
                if ( /function/i.test(typeof(obj[k])) )
                    continue;
                arr[i] = k +':'+ obj[k];
                ++i;
            }
            str = arr.sort().join(',');
        }

        return str;
    };

    /**
     * Check sum from a file or from form data.
     *
     * Dispatch: an object or array input is serialized first (a plain object as
     * sorted `key:value` pairs joined with `,` — see `objectToString`). A string
     * ending in an extension shape — a dot followed by 1-10 alphanumerics
     * (`.txt`, `.js`, `.json`, `.TXT`, `.c`, ...) — is then PROBED as a
     * filename: the file branch is taken only when the WHOLE string resolves to
     * an existing regular file — anything else (no such entry, name too long, a
     * directory, a NUL-carrying string) is hashed as data. Note the probe needs
     * an extension-shaped tail: an extension-less path (`Makefile`, `LICENSE`)
     * is hashed as a data string, never read from disk. (#B207/#B210)
     *
     * @param {string|object|array} filename|data - path to an existing file, or raw data
     * @param {string} [algorithm] - e.g.: sha1 (defaults to md5)
     * @param {string} [encoding] - e.g.: hex (default)
     *
     * @returns {string} checksum
     * @throws {Error} on an unreadable existing file (e.g. EACCES) or a digest failure
     *
     * @example
     *  var math = require('gina').lib.math;
     *  math.checkSumSync({ contact: 'user@example.com' }, 'sha1'); // hash of `contact:user@example.com`
     *  math.checkSumSync('/tmp/manifest.txt', 'sha1');             // hash of the file bytes
     * */
    self.checkSumSync = function(filename, algorithm, encoding) {
        var sum = null;
        try {

            if ( typeof(filename) == 'object' ) {
                filename = objectToString(filename);
            }

            // #B207 — an extension-shaped tail is only a HINT that the input is a
            // filename: serialized data ends the same way (`user@example.com`,
            // `report.pdf`). Only take the file branch when the path resolves to an
            // actual file; data that merely looks like a name falls through.
            var isFile = false;
            // #B210 — any real extension shape (dot + 1-10 alphanumerics), not just
            // dot+3-lowercase: file.js / file.json / FILE.TXT used to be hashed as
            // PATH STRINGS because the narrow probe never fired for them.
            if ( /(\.[A-Za-z0-9]{1,10})$/.test(filename) ) { // must be a string
                try {
                    isFile = fs.statSync(filename).isFile();
                } catch (statErr) {
                    // ENOENT / ENAMETOOLONG / ENOTDIR / ERR_INVALID_ARG_VALUE: the
                    // input cannot name an existing file — treat it as data. Anything
                    // else (e.g. EACCES on a real entry) must keep failing loudly.
                    if ( !/^(ENOENT|ENAMETOOLONG|ENOTDIR|ERR_INVALID_ARG_VALUE)$/.test(statErr.code) ) {
                        throw statErr;
                    }
                }
            }

            if (isFile) {
                // from filename
                sum = checkSum( fs.readFileSync(filename), algorithm, encoding )
            } else {
                // from data
                sum = checkSum( filename, algorithm, encoding, true )
            }

            if (sum instanceof Error)
                throw sum;
            else
                return sum;

        } catch (err) {
            //console.error(err.stack||err.message);
            //return undefined
            throw err;
        }
    };

    // for big files only: > 1Mb
    //self.checkSumBig= function(filename, cb) {
    //    var hash = crypto.createHash('md5');
    //    var encryption = encryption || 'sha1';
    //
    //    var stream = fs.createReadStream(filename);
    //    stream.on('data', function (data) {
    //        hash.update(data, 'utf8')
    //    })
    //
    //    stream.on('end', function () {
    //        hash.digest('hex');
    //    })
    //}
    return self;
}
module.exports = MathHelper();