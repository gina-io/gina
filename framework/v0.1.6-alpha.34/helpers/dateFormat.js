/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
/**
 * Credits & thanks to Steven Levithan :)
 * http://blog.stevenlevithan.com/archives/date-time-format
 *
 *
 *
 * Original Copyrights
 * Date Format 1.2.3
 * (c) 2007-2009 Steven Levithan <stevenlevithan.com>
 * MIT license
 *
 * Includes enhancements by Scott Trenda <scott.trenda.net>
 * and Kris Kowal <cixar.com/~kris.kowal/>
 *
 * Accepts a date, a mask, or a date and a mask.
 * Returns a formatted version of the given date.
 * The date defaults to the current date/time.
 * The mask defaults to dateFormat.masks.default.
 *
 * @param {string} date
 * @param {string} mask
 */
function DateFormatHelper() {

    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    var merge           = (isGFFCtx) ? require('lib/merge') : require('./../lib/merge');


    // if ( typeof(define) === 'function' && define.amd ) {
    //     var Date = this.Date;
    // }

    var self = {};
    // language-country
    self.culture = 'en-US'; // by default
    self.lang = 'en'; // by default

    self.masks = {
        // i18n
        "default":      "ddd mmm dd yyyy HH:MM:ss",
        shortDate:      "m/d/yy",
        shortDate2:      "mm/dd/yyyy",
        mediumDate:     "mmm d, yyyy",
        longDate:       "mmmm d, yyyy",
        fullDate:       "dddd, mmmm d, yyyy",
        // common
        cookieDate:     "GMT:ddd, dd mmm yyyy HH:MM:ss",
        logger:       "yyyy mmm dd HH:MM:ss",
        shortTime:      "h:MM TT",
        shortTime2:      "h:MM",
        mediumTime:     "h:MM:ss TT",
        mediumTime2:     "h:MM:ss",
        longTime:       "h:MM:ss TT Z",
        longTime2:       "h:MM:ss TT",
        concatenatedDate:  "yyyymmdd",
        isoDate:        "yyyy-mm-dd",
        isoTime:        "HH:MM:ss",
        shortIsoTime:        "HH:MM",
        longIsoTime:        "HH:MM:ss TT",
        isoDateTime:    "yyyy-mm-dd'T'HH:MM:ss",
        longIsoDateTime:    "yyyy-mm-dd'T'HH:MM:ss.L",
        isoUtcDateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss'Z'"
    };

    self.i18n = {
        'en': {
            dayNames: [
                "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat",
                "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
            ],
            monthNames: [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
                "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"
            ],
            masks: {
                "default":      "ddd mmm dd yyyy HH:MM:ss",
                shortDate:      "m/d/yy",
                shortDate2:      "mm/dd/yyyy",
                mediumDate:     "mmm d, yyyy",
                longDate:       "mmmm d, yyyy",
                fullDate:       "dddd, mmmm d, yyyy"
            }
        },
        'fr': {
            dayNames: [
                "dim", "lun", "mar", "mer", "jeu", "ven", "sam",
                "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"
            ],
            monthNames: [
                "Jan", "Fév", "Mar", "Avr", "Mai", "Jui", "Juil", "Aoû", "Sep", "Oct", "Nov", "Déc",
                "Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"
            ],
            masks: {
                "default":      "ddd mmm dd yyyy HH:MM:ss",
                shortDate:      "d/m/yy",
                shortDate2:      "dd/mm/yyyy",
                mediumDate:     "d mmm, yyyy",
                longDate:       "d mmmm, yyyy",
                fullDate:       "dddd, d mmmm, yyyy"
            }
        }
    };

    /**
     *
     * @param {string} culture (5 chars) | lang (2 chars)
     */
    var setCulture = function(date, culture) {
        if (/\-/.test(culture) ) {
            self.culture = culture;
            self.lang = culture.split(/\-/)[0];
        } else {
            self.lang = culture
        }

        return this
    }

    var format = function(date, mask, utc) {

        // if ( typeof(merge) == 'undefined' || !merge ) {
        //     merge = (isGFFCtx) ? require('lib/merge') : require('./../lib/merge');

        // }

        var dF          = self
            , i18n      = dF.i18n[dF.lang] || dF.i18n['en']
            //, masksList = merge(i18n.masks, dF.masks)
            , masksList = null
        ;

        try {
            masksList = merge(i18n.masks, dF.masks);
        } catch( mergeErr) {
            // called from logger - redefinition needed for none-dev env: cache issue
            isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
            merge           = (isGFFCtx) ? require('lib/merge') : require('./../lib/merge');
            masksList = merge(i18n.masks, dF.masks);
        }

        if ( typeof(dF.i18n[dF.culture]) != 'undefined' ) {
            i18n  = dF.i18n[dF.culture];
            if ( typeof(dF.i18n[dF.culture].mask) != 'undefined' ) {
                masksList = merge(i18n.masks, dF.masks)
            }
        }

        var	token = /d{1,4}|m{1,4}|yy(?:yy)?|([HhMsTt])\1?|[LloSZ]|"[^"]*"|'[^']*'/g,
            timezone = /\b(?:[PMCEA][SDP]T|(?:Pacific|Mountain|Central|Eastern|Atlantic) (?:Standard|Daylight|Prevailing) Time|(?:GMT|UTC)(?:[-+]\d{4})?)\b/g,
            timezoneClip = /[^-+\dA-Z]/g,
            pad = function (val, len) {
                val = String(val);
                len = len || 2;
                while (val.length < len) val = "0" + val;
                return val;
            };

        // You can't provide utc if you skip other args (use the "UTC:" mask prefix)
        if (arguments.length == 1 && Object.prototype.toString.call(date) == "[object String]" && !/\d/.test(date)) {
            mask = date;
            date = undefined;
        }

        // Passing date through Date applies Date.parse, if necessary
        date = date ? new Date(date) : new Date();
        if (isNaN(date)) throw SyntaxError("invalid date");

        mask = String(masksList[mask] || mask || masksList["default"]);

        // Allow setting the utc argument via the mask
        if (mask.slice(0, 4) == "UTC:") {
            mask = mask.slice(4);
            utc = true;
        }

        var	_ = utc ? "getUTC" : "get",
            d = date[_ + "Date"](),
            D = date[_ + "Day"](),
            m = date[_ + "Month"](),
            y = date[_ + "FullYear"](),
            H = date[_ + "Hours"](),
            M = date[_ + "Minutes"](),
            s = date[_ + "Seconds"](),
            L = date[_ + "Milliseconds"](),
            o = utc ? 0 : date.getTimezoneOffset(),
            flags = {
                d:    d,
                dd:   pad(d),
                ddd:  i18n.dayNames[D],
                dddd: i18n.dayNames[D + 7],
                m:    m + 1,
                mm:   pad(m + 1),
                mmm:  i18n.monthNames[m],
                mmmm: i18n.monthNames[m + 12],
                yy:   String(y).slice(2),
                yyyy: y,
                h:    H % 12 || 12,
                hh:   pad(H % 12 || 12),
                H:    H,
                HH:   pad(H),
                M:    M,
                MM:   pad(M),
                s:    s,
                ss:   pad(s),
                l:    pad(L, 3),
                // L:    pad(L > 99 ? Math.round(L / 10) : L),
                L:    pad(L),
                t:    H < 12 ? "a"  : "p",
                tt:   H < 12 ? "am" : "pm",
                T:    H < 12 ? "A"  : "P",
                TT:   H < 12 ? "AM" : "PM",
                Z:    utc ? "UTC" : (String(date).match(timezone) || [""]).pop().replace(timezoneClip, ""),
                o:    (o > 0 ? "-" : "+") + pad(Math.floor(Math.abs(o) / 60) * 100 + Math.abs(o) % 60, 4),
                S:    ["th", "st", "nd", "rd"][d % 10 > 3 ? 0 : (d % 100 - d % 10 != 10) * d % 10]
            };



        return mask.replace(token, function ($0) {
            return $0 in flags ? flags[$0] : $0.slice(1, $0.length - 1);
        });
    }

    /**
     * Get mask name from a given format
     *
     * @param {string} format
     *
     * @returns {string} maskName
     * */
    // var getMaskNameFromFormat = function (format) {

    //     var name = "default";

    //     for (var f in self.masks) {
    //         if ( self.masks[f] === format )
    //             return f
    //     }

    //     return name
    // }


    /**
     *  Count days from the current date to another
     *
     *  TODO - add a closure to `ignoreWeekend()` based on Lib::Validator
     *  TODO - add a closure to `ignoreFromList(array)` based on Lib::Validator
     *
     *  @param {object} dateTo
     *  @returns {number} count
     * */
    var countDaysTo = function(date, dateTo) {

        if ( dateTo instanceof Date) {
            // The number of milliseconds in one day
            var oneDay = 1000 * 60 * 60 * 24

            // Convert both dates to milliseconds
            var date1Ms = date.getTime()
            var date2Ms = dateTo.getTime()

            // Calculate the difference in milliseconds
            var count = Math.abs(date1Ms - date2Ms)

            // Convert back to days and return
            return Math.round(count/oneDay);
        } else {
            throw new Error('dateTo is not instance of Date() !')
        }
    }

    /**
     *  Will give an array of dates between the current date to a targeted date
     *
     *  TODO - add a closure to `ignoreWeekend()` based on Lib::Validator
     *  TODO - add a closure to `ignoreFromList(array)` based on Lib::Validator
     *
     *  @param {object} dateTo
     *  @param {string} [ mask ]
     *
     *  @returns {array} dates
     * */
    var getDaysTo = function(date, dateTo, mask) {

        if ( dateTo instanceof Date) {
            var count       = countDaysTo(date, dateTo)
                , month     = date.getMonth()
                , year      = date.getFullYear()
                , day       = date.getDate() + 1
                , dateObj   = new Date(year, month, day)
                , days      = []
                , i         = 0;

            for (; i < count; ++i) {
                if ( typeof(mask) != 'undefined' ) {
                    days.push(new Date(dateObj).format(mask));
                } else {
                    days.push(new Date(dateObj));
                }

                dateObj.setDate(dateObj.getDate() + 1);
            }

            return days || [];
        } else {
            throw new Error('dateTo is not instance of Date() !')
        }
    }

    var getDaysInMonth = function(date) {
        var month   = date.getMonth();
        var year    = date.getFullYear();
        var dateObj = new Date(year, month, 1);
        var days = [];
        while (dateObj.getMonth() === month) {
            days.push(new Date(dateObj));
            dateObj.setDate(dateObj.getDate() + 1);
        }
        return days;
    }


    /**
     * getQuarter
     * Get quarter number
     * To test : https://planetcalc.com/1252/
     * Based on fiscal year- See.: https://en.wikipedia.org/wiki/Fiscal_year
     *
     * TODO - Complete fiscalCodes
     *
     * @param {object} [date] if not defined, will take today's value
     * @param {string} [code] - us|eu
     *
     * @returns {number} quarterNumber - 1 to 4
     */
    var fiscalCodes = ['us', 'eu', 'corporate'];
    var getQuarter = function(date, code) {
        if (
            arguments.length == 1
            && typeof(arguments[0]) == 'string'
        ) {
            if ( fiscalCodes.indexOf(arguments[0].toLowerCase()) < 0 ) {
                throw new Error('Quarter '+ arguments[0] +' code not supported !');
            }
            date = new Date();
            code = arguments[0]
        }
        if ( typeof(date) == 'undefined' ) {
            date = new Date();
        }
        if ( typeof(code) == 'undefined') {
            code = 'corporate';
        }

        code = code.toLowerCase();
        var q = [1,2,3,4]; // EU & corporates by default
        switch (code) {
            case 'us':
                q = [4,1,2,3];
                break;

            case 'corportate':
            case 'eu':
                q = [1,2,3,4]
                break;
            default:
                // EU & corporates by default
                q = [1,2,3,4];
                break;
        }

        return q[Math.floor(date.getMonth() / 3)];
    }

    /**
     * getHalfYear
     *
     * Based on fiscal year- See.: https://en.wikipedia.org/wiki/Fiscal_year
     *
     * @param {object} date
     * @param {string} code
     *
     * @returns halfYear number - 1 to 2
     */
    var getHalfYear = function(date, code) {
        if (
            arguments.length == 1
            && typeof(arguments[0]) == 'string'
        ) {
            if ( fiscalCodes.indexOf(arguments[0].toLowerCase()) < 0 ) {
                throw new Error('Quarter '+ arguments[0] +' code not supported !');
            }
            date = new Date();
            code = arguments[0]
        }
        if ( typeof(date) == 'undefined' ) {
            date = new Date();
        }
        if ( typeof(code) == 'undefined') {
            code = 'corporate';
        }

        code = code.toLowerCase();

        return (date.getQuarter(code) <=2 ) ? 1 : 2;
    }

    /**
     * getWeekISO8601
     * Get week number
     * ISO 8601
     * To test : https://planetcalc.com/1252/
     *
     * @param {object} [date] if not defined, will take today's value
     *
     * @returns {number} weekNumber
     */
    var getWeekISO8601 = function(date) {
        // Copy date so don't modify original
        d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        // Make Sunday's day number 7
        var dayNum = d.getDay() || 7;
        d.setDate(d.getDate() + 4 - dayNum);
        var yearStart = new Date(Date.parse(d.getFullYear(),0,1));

        return Math.ceil((((d - yearStart) / 86400000) + 1)/7)
    }

    /**
     * getWeek
     * Get week number
     * To test : https://planetcalc.com/1252/
     *
     * @param {object} [date] if not defined, will take today's value
     *
     * @returns {number} weekNumber - 1 to 53
     */
    var getWeek = function(date, standardMethod) {
        if ( typeof(date) == 'undefined' ) {
            date = new Date();
        }
        if ( typeof(standardMethod) == 'undefined') {
            standardMethod = 'ISO 8601';
        }

        standardMethod = standardMethod.replace(/\s+/g, '').toLowerCase();
        switch (standardMethod) {
            case 'corporate':
            case 'eu':
            case 'iso8601':
                return getWeekISO8601(date)

            default:
                return getWeekISO8601(date)
        }
    }

    /**
     * Add or subtract hours
     *  Adding 2 hours
     *      => myDate.addHours(2)
     *  Subtracting 10 hours
     *      => myDate.addHours(-10)
     * */
    var addHours = function(date, h) {
        var copiedDate = new Date(date.getTime());
        copiedDate.setHours(copiedDate.getHours() + h);
        return copiedDate;
    }


    /**
     * Add or subtract days
     *  Adding 2 days
     *      => myDate.addDays(2)
     *  Subtracting 10 days
     *      => myDate.addDays(-10)
     * */
    var addDays = function(date, d) {
        var copiedDate = new Date(date.getTime());
        copiedDate.setHours(copiedDate.getHours() + d * 24);
        return copiedDate;
    }

    /**
     * Add or subtract years
     *  Adding 2 days
     *      => myDate.addYears(2)
     *  Subtracting 10 years
     *      => myDate.addYears(-10)
     * */
    var addYears = function(date, y) {
        var copiedDate = new Date(date.getTime());
        copiedDate.setFullYear(copiedDate.getFullYear() + y);
        return copiedDate;
    }

    var _proto = {
        setCulture      : setCulture,
        format          : format,
        countDaysTo     : countDaysTo,
        getDaysTo       : getDaysTo,
        getDaysInMonth  : getDaysInMonth,
        getQuarter      : getQuarter,
        getHalfYear     : getHalfYear,
        getWeek         : getWeek,
        addHours        : addHours,
        addDays         : addDays,
        addYears        : addYears
    };

    return _proto

};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = DateFormatHelper
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return DateFormatHelper })
}