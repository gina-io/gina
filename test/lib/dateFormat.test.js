var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var DateFormatHelper = require('../../framework/v0.1.6-alpha.177/helpers/dateFormat');
var df = DateFormatHelper();

// Fixed reference date: 2024-07-15 14:30:45.123 (Monday)
var refDate = new Date(2024, 6, 15, 14, 30, 45, 123);


describe('format — mask tokens', function () {

    it('isoDate: yyyy-mm-dd', function () {
        assert.equal(df.format(refDate, 'isoDate'), '2024-07-15');
    });

    it('isoTime: HH:MM:ss', function () {
        assert.equal(df.format(refDate, 'isoTime'), '14:30:45');
    });

    it('shortIsoTime: HH:MM', function () {
        assert.equal(df.format(refDate, 'shortIsoTime'), '14:30');
    });

    it('isoDateTime: yyyy-mm-ddTHH:MM:ss', function () {
        assert.equal(df.format(refDate, 'isoDateTime'), '2024-07-15T14:30:45');
    });

    it('longIsoDateTime: yyyy-mm-ddTHH:MM:ss.L', function () {
        assert.equal(df.format(refDate, 'longIsoDateTime'), '2024-07-15T14:30:45.123');
    });

    it('concatenatedDate: yyyymmdd', function () {
        assert.equal(df.format(refDate, 'concatenatedDate'), '20240715');
    });

    it('shortDate: m/d/yy', function () {
        assert.equal(df.format(refDate, 'shortDate'), '7/15/24');
    });

    it('shortDate2: mm/dd/yyyy', function () {
        assert.equal(df.format(refDate, 'shortDate2'), '07/15/2024');
    });

    it('mediumDate: mmm d, yyyy', function () {
        assert.equal(df.format(refDate, 'mediumDate'), 'Jul 15, 2024');
    });

    it('longDate: mmmm d, yyyy', function () {
        assert.equal(df.format(refDate, 'longDate'), 'July 15, 2024');
    });

    it('fullDate: dddd, mmmm d, yyyy', function () {
        assert.equal(df.format(refDate, 'fullDate'), 'Monday, July 15, 2024');
    });

    it('shortTime: h:MM TT', function () {
        assert.equal(df.format(refDate, 'shortTime'), '2:30 PM');
    });

    it('mediumTime: h:MM:ss TT', function () {
        assert.equal(df.format(refDate, 'mediumTime'), '2:30:45 PM');
    });

    it('day ordinal suffix S', function () {
        assert.equal(df.format(new Date(2024, 0, 1), 'dS'), '1st');
        assert.equal(df.format(new Date(2024, 0, 2), 'dS'), '2nd');
        assert.equal(df.format(new Date(2024, 0, 3), 'dS'), '3rd');
        assert.equal(df.format(new Date(2024, 0, 4), 'dS'), '4th');
        assert.equal(df.format(new Date(2024, 0, 11), 'dS'), '11th');
        assert.equal(df.format(new Date(2024, 0, 21), 'dS'), '21st');
    });

    it('AM/PM for morning hours', function () {
        var morning = new Date(2024, 6, 15, 9, 5, 3);
        assert.equal(df.format(morning, 'h:MM:ss TT'), '9:05:03 AM');
        assert.equal(df.format(morning, 'HH:MM'), '09:05');
    });

    it('custom mask string', function () {
        assert.equal(df.format(refDate, 'dd/mm/yyyy HH:MM'), '15/07/2024 14:30');
    });
});


describe('format — UTC prefix', function () {

    it('isoUtcDateTime mask', function () {
        var result = df.format(refDate, 'isoUtcDateTime');
        assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('UTC: prefix forces UTC mode', function () {
        var result = df.format(refDate, 'UTC:HH:MM');
        var expected = String(refDate.getUTCHours()).padStart(2, '0') + ':' + String(refDate.getUTCMinutes()).padStart(2, '0');
        assert.equal(result, expected);
    });
});


describe('format — i18n (French)', function () {

    it('French fullDate', function () {
        var frDf = DateFormatHelper();
        frDf.setCulture(refDate, 'fr');
        assert.equal(frDf.format(refDate, 'fullDate'), 'lundi, 15 Juillet, 2024');
    });

    it('French shortDate (d/m/yy)', function () {
        var frDf = DateFormatHelper();
        frDf.setCulture(refDate, 'fr');
        assert.equal(frDf.format(refDate, 'shortDate'), '15/7/24');
    });

    it('French month names', function () {
        var frDf = DateFormatHelper();
        frDf.setCulture(refDate, 'fr');
        assert.equal(frDf.format(new Date(2024, 0, 1), 'mmmm'), 'Janvier');
        assert.equal(frDf.format(new Date(2024, 7, 1), 'mmmm'), 'Ao\u00fbt');
    });

    it('setCulture with lang only', function () {
        var frDf = DateFormatHelper();
        frDf.setCulture(refDate, 'fr');
        assert.equal(frDf.format(refDate, 'ddd'), 'lun');
    });

    it('setCulture with full culture code', function () {
        var frDf = DateFormatHelper();
        frDf.setCulture(refDate, 'fr-FR');
        assert.equal(frDf.format(refDate, 'ddd'), 'lun');
    });
});


describe('format — edge cases', function () {

    it('throws on invalid date', function () {
        assert.throws(function () {
            df.format('not a date', 'isoDate');
        }, SyntaxError);
    });

    it('midnight (hour 0) formats as 12 for h token', function () {
        var midnight = new Date(2024, 0, 1, 0, 0, 0);
        assert.equal(df.format(midnight, 'h:MM TT'), '12:00 AM');
    });

    it('noon (hour 12) formats as 12 PM', function () {
        var noon = new Date(2024, 0, 1, 12, 0, 0);
        assert.equal(df.format(noon, 'h:MM TT'), '12:00 PM');
    });

    it('single-digit day and month without padding', function () {
        var jan1 = new Date(2024, 0, 1, 0, 0, 0);
        assert.equal(df.format(jan1, 'm/d/yyyy'), '1/1/2024');
    });
});


describe('countDaysTo', function () {

    it('counts days between two dates', function () {
        var from = new Date(2024, 0, 1);
        var to = new Date(2024, 0, 31);
        assert.equal(df.countDaysTo(from, to), 30);
    });

    it('returns 0 for the same date', function () {
        var date = new Date(2024, 6, 15);
        assert.equal(df.countDaysTo(date, date), 0);
    });

    it('is absolute (order does not matter)', function () {
        var from = new Date(2024, 0, 1);
        var to = new Date(2024, 0, 31);
        assert.equal(df.countDaysTo(from, to), df.countDaysTo(to, from));
    });

    it('throws if dateTo is not a Date', function () {
        assert.throws(function () {
            df.countDaysTo(new Date(), 'not a date');
        }, Error);
    });
});


describe('addHours', function () {

    it('adds positive hours', function () {
        var result = df.addHours(refDate, 2);
        assert.equal(result.getHours(), 16);
        assert.notEqual(result, refDate); // returns new object
    });

    it('subtracts negative hours', function () {
        var result = df.addHours(refDate, -3);
        assert.equal(result.getHours(), 11);
    });

    it('does not mutate original date', function () {
        var original = new Date(refDate.getTime());
        df.addHours(refDate, 5);
        assert.equal(refDate.getTime(), original.getTime());
    });
});


describe('addDays', function () {

    it('adds positive days', function () {
        var result = df.addDays(refDate, 10);
        assert.equal(result.getDate(), 25);
    });

    it('subtracts negative days', function () {
        var result = df.addDays(refDate, -5);
        assert.equal(result.getDate(), 10);
    });

    it('crosses month boundary', function () {
        var jan30 = new Date(2024, 0, 30);
        var result = df.addDays(jan30, 3);
        assert.equal(result.getMonth(), 1); // February
        assert.equal(result.getDate(), 2);
    });

    it('does not mutate original date', function () {
        var original = new Date(refDate.getTime());
        df.addDays(refDate, 10);
        assert.equal(refDate.getTime(), original.getTime());
    });
});


describe('addYears', function () {

    it('adds positive years', function () {
        var result = df.addYears(refDate, 3);
        assert.equal(result.getFullYear(), 2027);
    });

    it('subtracts negative years', function () {
        var result = df.addYears(refDate, -5);
        assert.equal(result.getFullYear(), 2019);
    });

    it('does not mutate original date', function () {
        var original = new Date(refDate.getTime());
        df.addYears(refDate, 1);
        assert.equal(refDate.getTime(), original.getTime());
    });
});


describe('getQuarter', function () {

    it('Q1 (Jan-Mar) corporate/eu', function () {
        assert.equal(df.getQuarter(new Date(2024, 0, 15)), 1);
        assert.equal(df.getQuarter(new Date(2024, 2, 31)), 1);
    });

    it('Q2 (Apr-Jun) corporate/eu', function () {
        assert.equal(df.getQuarter(new Date(2024, 3, 1)), 2);
        assert.equal(df.getQuarter(new Date(2024, 5, 30)), 2);
    });

    it('Q3 (Jul-Sep) corporate/eu', function () {
        assert.equal(df.getQuarter(new Date(2024, 6, 1)), 3);
        assert.equal(df.getQuarter(new Date(2024, 8, 30)), 3);
    });

    it('Q4 (Oct-Dec) corporate/eu', function () {
        assert.equal(df.getQuarter(new Date(2024, 9, 1)), 4);
        assert.equal(df.getQuarter(new Date(2024, 11, 31)), 4);
    });

    it('US fiscal year: Q4 for Jan-Mar, Q1 for Apr-Jun', function () {
        assert.equal(df.getQuarter(new Date(2024, 0, 15), 'us'), 4);
        assert.equal(df.getQuarter(new Date(2024, 3, 1), 'us'), 1);
    });

    it('throws on unsupported code', function () {
        assert.throws(function () {
            df.getQuarter('invalid_code');
        }, Error);
    });
});


describe('getWeek', function () {

    it('first week of 2024 (ISO 8601)', function () {
        // 2024-01-01 is Monday — week 1
        assert.equal(df.getWeek(new Date(2024, 0, 1)), 1);
    });

    it('last week of 2024', function () {
        var result = df.getWeek(new Date(2024, 11, 31));
        assert.equal(typeof result, 'number');
        assert.ok(result >= 1 && result <= 53);
    });

    it('mid-year week', function () {
        // July 15 2024 is week 29
        var result = df.getWeek(refDate);
        assert.equal(result, 29);
    });
});


describe('getDaysInMonth', function () {

    it('January has 31 days', function () {
        var result = df.getDaysInMonth(new Date(2024, 0, 1));
        assert.equal(result.length, 31);
    });

    it('February 2024 (leap year) has 29 days', function () {
        var result = df.getDaysInMonth(new Date(2024, 1, 1));
        assert.equal(result.length, 29);
    });

    it('February 2023 (non-leap) has 28 days', function () {
        var result = df.getDaysInMonth(new Date(2023, 1, 1));
        assert.equal(result.length, 28);
    });

    it('returns array of Date objects', function () {
        var result = df.getDaysInMonth(new Date(2024, 0, 1));
        assert.ok(result[0] instanceof Date);
        assert.equal(result[0].getDate(), 1);
        assert.equal(result[result.length - 1].getDate(), 31);
    });
});
