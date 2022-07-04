/**
 * Credits & thanks to Steven Levithan :)
 * http://blog.stevenlevithan.com/archives/date-time-format
 *
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

    var self = {};

    self.masks = {
        "default":      "ddd mmm dd yyyy HH:MM:ss",
        shortDate:      "m/d/yy",
        shortDate2:      "mm/dd/yyyy",
        mediumDate:     "mmm d, yyyy",
        longDate:       "mmmm d, yyyy",
        fullDate:       "dddd, mmmm d, yyyy",
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
        isoUtcDateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss'Z'"
    };


    self.i18n = {
        dayNames: [
            "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat",
            "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
        ],
        monthNames: [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"
        ]
    };

    var format = function(date, mask, utc) {
        var dF = self;

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
        date = date ? new Date(date) : new Date;
        if (isNaN(date)) throw SyntaxError("invalid date");

        mask = String(dF.masks[mask] || mask || dF.masks["default"]);

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
                ddd:  dF.i18n.dayNames[D],
                dddd: dF.i18n.dayNames[D + 7],
                m:    m + 1,
                mm:   pad(m + 1),
                mmm:  dF.i18n.monthNames[m],
                mmmm: dF.i18n.monthNames[m + 12],
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
                L:    pad(L > 99 ? Math.round(L / 10) : L),
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
     * @return {string} maskName
     * */
    var getMaskNameFromFormat = function (format) {

        var name = "default";

        for (var f in self.masks) {
            if ( self.masks[f] === format )
                return f
        }

        return name
    }


    /**
     *  Count days from the current date to another
     *
     *  TODO - add a closure to `ignoreWeekend()` based on Utils::Validator
     *  TODO - add a closure to `ignoreFromList(array)` based on Utils::Validator
     *
     *  @param {object} dateTo
     *  @return {number} count
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
     *  TODO - add a closure to `ignoreWeekend()` based on Utils::Validator
     *  TODO - add a closure to `ignoreFromList(array)` based on Utils::Validator
     *
     *  @param {object} dateTo
     *  @param {string} [ mask ]
     *
     *  @return {array} dates
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
     * Add or subtract hours
     *  Adding 2 hours
     *      => myDate.addHours(2)
     *  Subtracting 10 hours
     *      => myDate.addHours(-10)
     * */
    var addHours = function(date, h) {
        var copiedDate = new Date(date.getTime());
        copiedDate.setHours(copiedDate.getHours()+h);
        return copiedDate;
    }

    return {
        format          : format,
        countDaysTo     : countDaysTo,
        getDaysTo       : getDaysTo,
        getDaysInMonth  : getDaysInMonth,
        addHours        : addHours
    }

};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = DateFormatHelper
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return DateFormatHelper })
}