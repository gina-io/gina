//'use strict';
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
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
     * Operate from a string value
     *
     * e.g.:
     *
     *  var operate = require("gina").lib.math.operate;
     *  var computation = "10*2";
     *  var result = operate(computation);
     *      => 20
     *
     *  @param {string} calcultation
     *
     *  @returns {number} result
     * */
    self.operate = function(computation) {
        return new Function('return ' + computation)();
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

    var objectToString = function(obj) {
        var str = '';
        if (Array.isArray(obj)) {
            obj = JSON.stringify(obj.sort(), null, 0);
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
     * Check sum from file or form data
     *
     * @param {string|ojbect|array} filename|data
     * @param {string} algorithm
     * @param {string} encoding
     *
     * @returns {string} checksum
     * */
    self.checkSumSync = function(filename, algorithm, encoding) {
        var sum = null;
        try {

            if ( typeof(filename) == 'object' ) {
                filename = objectToString(filename);
            }

            if ( /(\.[a-z]{3})$/.test(filename) ) { // must be a string
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