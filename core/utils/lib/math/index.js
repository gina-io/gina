/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
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
 * @package     gina.utils.math
 * @author      Rhinostone <gina@rhinostone.com>
 * @api public
 * */

function Math() {

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
     *  var operate = require("gina").utils.math.operate;
     *  var calculation = "10*2";
     *  var result = operate(calculation);
     *      => 20
     *
     *  @param {string} calcultation
     *
     *  @return {number} result
     * */
    this.operate = function(calculation) {
        return new Function('return ' + calculation)()
    }

    /**
     * Checksum
     * e.g: checksum(data, 'sha1')
     *
     * @param {string} str - Data to analyse
     * @param {string} algorithm
     * @param {string} [ encoding ] - e.g.: hex
     *
     * @return {string} checksum
     * */
    var checkSum = function (str, algorithm, encoding) {
        try {
            return crypto
                .createHash(algorithm || 'md5')
                .update(str, 'utf8')
                .digest(encoding || 'hex')
        } catch (err) {
            return err
        }
    }

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
    this.checkSum = function(filename, algorithm, encoding, cb) {
        var err = false, sum = null;

        if ( /\./.test(filename) ) {
            fs.readFile(filename, function (err, data) {
                sum = checkSum(data, algorithm, encoding);
                if( sum instanceof Error) {
                    err = sum;
                    sum = undefined
                }

                cb(err, sum)
            })
        } else {
            sum = checkSum(filename, algorithm, encoding);
            if( sum instanceof Error) {
                err = sum;
                sum = undefined
            }

            cb(err, sum)
        }
    }

    /**
     * Check sum from file or form data
     *
     * @param {string} filename|data
     * @param {string} algorithm
     * @param {string} encoding
     *
     * @return {string} checksum
     * */
    this.checkSumSync = function(filename, algorithm, encoding) {
        var sum = null;
        try {
            if ( /(\.[a-z]{3})$/.test(filename) ) { // must be a string
                // from filename
                sum = checkSum( fs.readFileSync(filename), algorithm, encoding )
            } else {
                // from data
                sum = checkSum( filename, algorithm, encoding )
            }

            if (sum instanceof Error)
                throw sum;
            else
                return sum

        } catch (err) {
            //console.error(err.stack||err.message);
            //return undefined
            throw err
        }
    }

    // for big files only: > 1Mb
    //this.checkSumBig= function(filename, cb) {
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

    //init();
    return this
}
module.exports = Math()