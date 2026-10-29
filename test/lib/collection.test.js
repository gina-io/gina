var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var helpers = require(path.join(require('../fw'), 'helpers'));
var Collection = require(path.join(require('../fw'), 'lib/collection/src/main'));

var dataDir = path.join(require('../fw'), 'lib/collection/test/data');
var resultDir = path.join(dataDir, 'result/hotel');

var deepEqual = function (obj, obj2) {
    return (JSON.stringify(obj) === JSON.stringify(obj2)) ? true : false;
};


// 01 — find
describe('01 - find', function () {

    var data = {
        hotels: JSON.parse(fs.readFileSync(path.join(dataDir, 'hotel.json')))
    };

    it('Instance is Array', function () {
        var hotels = new Collection(data.hotels);
        assert.equal(Array.isArray(hotels), true);
    });

    it('find limit: Hotel WHERE country === France, limit 2', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .find({ country: 'France' })
            .limit(2)
            .toRaw();

        var mocks = JSON.parse(fs.readFileSync(path.join(resultDir, 'find/findHotelWhereCountryIsFrance.json')));

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, mocks.length);
    });

    it('find withOrClause: Hotel WHERE name = Le Clos Fleuri OR name = Hotel d\'Angleterre', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .find(
                { type: 'hotel', name: 'Le Clos Fleuri' },
                { type: 'hotel', name: "Hotel d'Angleterre" }
            )
            .toRaw();

        var mocks = JSON.parse(fs.readFileSync(path.join(resultDir, "find/findHotelWhereNameIs_Le Clos FleuriOrNameIsHotel d_Angleterre.json")));

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, mocks.length);
        assert.equal(deepEqual(result, mocks), true);
    });

    it('find notIn filters: Hotel WHERE country NOTIN UK OR NOTIN USA', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .notIn({ country: 'United Kingdom' }, { country: 'United States' })
            .toRaw();

        var mocks = JSON.parse(fs.readFileSync(path.join(resultDir, 'find/findHotelWhereCountryNotInUkOrNotInUsa.json')));

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, mocks.length);
        assert.equal(deepEqual(result, mocks), true);
    });

    it('find notIn filters: Filtered By fields city and id', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .notIn({ country: 'United Kingdom' }, { country: 'United States' })
            .filter(['city', 'id']);

        var mocks = JSON.parse(fs.readFileSync(path.join(resultDir, 'find/findHotelWhereCountryNotInUkOrNotInUsaFilteredOnIdAndCity.json')));

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, mocks.length);
        assert.equal(deepEqual(result, mocks), true);
    });

    it('find notIn Array: Hotel WHERE country == France AND state == PACA AND city NOTIN Orange', function () {
        var hotels = new Collection(data.hotels);
        var excludedCity = hotels.find({ country: 'France', city: 'Orange' });

        var result = hotels
            .find({ country: 'France', state: "Provence-Alpes-Côte d'Azur" })
            .notIn(excludedCity, 'id')
            .toRaw();

        var mocks = JSON.parse(fs.readFileSync(path.join(resultDir, 'find/findHotelWhereCountryIsFranceAndStateIsPacaAndCityNotInOrange.json')));

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, mocks.length);
        assert.deepStrictEqual(result, mocks);
    });

    it('find within: Hotel WHERE country == UK AND pets_ok == true AND reviews[*].Cleanliness >= 4', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .find({ country: 'United Kingdom', pets_ok: true, 'reviews[*].ratings.Cleanliness': '>= 4' })
            .toRaw();

        var mocks = JSON.parse(fs.readFileSync(path.join(resultDir, 'find/findHotelWhereCountryIsUkAndPetsOkAndReviewsCleanlinessRanksMoreThan4.json')));

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, mocks.length);
        assert.deepStrictEqual(result, mocks);
    });
});


// 02 — notIn
describe('02 - notIn', function () {

    var data = {
        hotels: JSON.parse(fs.readFileSync(path.join(dataDir, 'hotel.json')))
    };

    it('notIn from empty source returns [] (#B1029): Hotel WHERE country === France, limit 2', function () {
        var hotels = new Collection(data.hotels);
        var emptySourceCollection = new Collection([]);

        var found = hotels
            .find({ country: 'France' })
            .limit(2);
        assert.equal(found.length, 2, 'control: two hotels are found to exclude');

        var result = emptySourceCollection.notIn(found).toRaw();

        // #B1029 — an empty source has no row to keep. Up to 0.7.7 the rows
        // found came back as the result (« current === found »).
        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, 0);
        assert.deepStrictEqual(result, []);
    });
});


// 03 — findOne
describe('03 - findOne', function () {

    var data = {
        hotels: JSON.parse(fs.readFileSync(path.join(dataDir, 'hotel.json')))
    };

    it('findOne by filter: Hotel WHERE country === France AND name === Le Clos Fleuri', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .findOne({ country: 'France', name: 'Le Clos Fleuri' });

        var mocks = JSON.parse(fs.readFileSync(path.join(resultDir, "find/findOneHotelWhereCountryIsFranceAndNameIs_Le Clos Fleuri.json")));

        assert.deepStrictEqual(result, mocks);
    });

    it('findOne by filter ignoring case: Hotel WHERE country === France AND name == le clos fleuri', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .setSearchOption('name', 'isCaseSensitive', false)
            .findOne({ country: 'France', name: 'le clos fleuri' });

        var mocks = JSON.parse(fs.readFileSync(path.join(resultDir, "find/findOneHotelWhereCountryIsFranceAndNameIs_Le Clos Fleuri.json")));

        assert.deepStrictEqual(result, mocks);
    });
});


// 04 — orderBy
describe('04 - orderBy', function () {

    var data = {
        hotels: JSON.parse(fs.readFileSync(path.join(dataDir, 'hotel.json')))
    };

    it('find all: Hotel orderBy name ASC limit 10', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .orderBy({ name: 'asc' })
            .limit(10)
            .toRaw();

        assert.equal(Array.isArray(result), true);
    });
});


// 05 — delete
describe('05 - delete', function () {

    var data = {
        hotels: JSON.parse(fs.readFileSync(path.join(dataDir, 'hotel.json'))),
        hotelsWithoutIds: JSON.parse(fs.readFileSync(path.join(dataDir, 'hotel-without-ids.json'))),
        hotelsWithUuids: JSON.parse(fs.readFileSync(path.join(dataDir, 'hotel-with-_uuids.json')))
    };

    it('delete: Hotel WHERE country = France', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .delete({ country: 'France' })
            .toRaw();

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, 777);

        var mocks = requireJSON(path.join(resultDir, 'delete/deleteHotelWhereCountryIsFrance.json'));
        assert.deepStrictEqual(result, mocks);
    });

    it('delete: Hotel WHERE vacancy = true', function () {
        var hotels = new Collection(data.hotels);
        var result = hotels
            .delete({ vacancy: true })
            .toRaw();

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, 449);

        var mocks = requireJSON(path.join(resultDir, 'delete/deleteHotelWhereVacancyIsTrue.json'));
        assert.deepStrictEqual(result, mocks);
    });

    it('delete: Hotel without ids WHERE country = France', function () {
        var hotelsWithoutIds = new Collection(data.hotelsWithoutIds);
        var result = hotelsWithoutIds
            .delete({ country: 'France' })
            .toRaw();

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, 777);

        var mocks = requireJSON(path.join(resultDir, 'delete/deleteHotelWithoutIdsWhereCountryIsFrance.json'));
        assert.deepStrictEqual(result, mocks);
    });

    it('delete: Hotel with uuids WHERE country = France', function () {
        var hotelsWithUuids = new Collection(data.hotelsWithUuids);
        var result = hotelsWithUuids
            .delete({ country: 'France' })
            .toRaw();

        assert.equal(Array.isArray(result), true);
        assert.equal(result.length, 777);

        var mocks = requireJSON(path.join(resultDir, 'delete/deleteHotelWithUuidsWhereCountryIsFrance.json'));
        assert.deepStrictEqual(result, mocks);
    });
});


// 06 — #SCS1d source-inspection guards (2026-04-23)
// Locks the refactor: live code must no longer reach `eval(` or `new Function(`.
// Matches the #SCS1 follow-up pattern from test/lib/math.test.js.
describe('06 - SCS1d source-inspection guards', function () {

    var collectionSource = fs.readFileSync(
        path.join(require('../fw'), 'lib/collection/src/main.js'),
        'utf8'
    );

    it('no longer calls `eval(`', function () {
        var stripped = collectionSource.replace(/^\s*\/\/.*$/gm, '');
        assert.ok(
            !/\beval\s*\(/.test(stripped),
            'live code still contains `eval(`'
        );
    });

    it('no longer calls `new Function(`', function () {
        var stripped = collectionSource.replace(/^\s*\/\/.*$/gm, '');
        assert.ok(
            !/\bnew\s+Function\s*\(/.test(stripped),
            'live code still contains `new Function(`'
        );
    });

    it('carries the #SCS1d provenance comment', function () {
        assert.ok(
            /#SCS1d/.test(collectionSource),
            '#SCS1d tag should be present'
        );
    });
});


// 07 — #SCS1d date comparison (coverage gap fill; the `new Date(...)` branch
// at the refactored tryEval sites had no prior test coverage)
describe('07 - SCS1d date comparison', function () {

    var events = [
        { name: 'A', date: '2024-03-15 12:00:00' },
        { name: 'B', date: '2023-06-20 15:30:00' },
        { name: 'C', date: '2025-01-01 00:00:00' }
    ];

    it('filter `date >= 2024-01-01 00:00:00` returns A and C', function () {
        var col = new Collection(events);
        var result = col.find({ date: '>= 2024-01-01 00:00:00' }).toRaw();
        var names = result.map(function (r) { return r.name; }).sort();
        assert.deepStrictEqual(names, ['A', 'C']);
    });

    it('filter `date < 2024-01-01 00:00:00` returns only B', function () {
        var col = new Collection(events);
        var result = col.find({ date: '< 2024-01-01 00:00:00' }).toRaw();
        var names = result.map(function (r) { return r.name; }).sort();
        assert.deepStrictEqual(names, ['B']);
    });
});


// 08 — #SCS1d injection rejection (security contract lock)
// The old eval-based paths executed any JS a filter string parsed as; the new
// safe evaluator + dot-path walker reject anything outside the closed grammar.
describe('08 - SCS1d injection rejection', function () {

    var data = [
        { name: 'alice', rating: { score: 5 } },
        { name: 'bob',   rating: { score: 3 } }
    ];

    it('rejects JS injection via a filter value (tryEval grammar)', function () {
        // Old: tryEval(`5> 0; throw new Error('INJECTED'); //`) executes the throw.
        // New: regex-based grammar rejects anything after the right operand.
        var col = new Collection(data);
        assert.throws(function () {
            col.find({ 'rating.score': "> 0; throw new Error('INJECTED');" });
        }, /Could not evaluate condition/);
    });

    it('silently drops a filter key containing JS metacharacters (dot-path walker)', function () {
        // Old: eval('_content.' + f) where f = `rating.constructor('return 1')()` executes.
        // New: walker rejects non-identifier chars; the surrounding try/catch swallows
        // the throw and the field is treated as absent (no match).
        var col = new Collection(data);
        var result = col.find({ "rating.constructor('return 1')()": 'anything' }).toRaw();
        assert.equal(result.length, 0);
    });
});


// 09 — _uuid collision-free indexing (#COLL1)
//
// Pins the indexing invariant. The bug: lib/collection called uuid() with the
// default 4-char base-62 (~14.78M space) once per record during construction;
// at N=917 records the birthday-paradox collision rate is ~2.84% per
// `new Collection()` call, and `notIn()`'s _uuid-keyed splice removes the wrong
// record on collision. The fix: lib/collection now calls uuid(16) explicitly
// (~4.77e28 space → collision rate at N=917 is ~9e-21, stays below 1e-13 up to
// N=100M). lib/uuid's own default is unchanged.
describe('09 - _uuid collision-free indexing (#COLL1)', function () {

    var data = {
        hotelsWithoutIds: JSON.parse(fs.readFileSync(path.join(dataDir, 'hotel-without-ids.json')))
    };

    it('100 successive constructions of new Collection(N=' + 917 + ') produce zero duplicate _uuids', function () {
        var iterations = 100;
        var totalCollisions = 0;
        var firstCollisionIter = -1;
        for (var i = 0; i < iterations; i++) {
            var col = new Collection(data.hotelsWithoutIds);
            var seen = Object.create(null);
            for (var j = 0, jLen = col.length; j < jLen; j++) {
                var u = col[j]._uuid;
                if (seen[u]) {
                    totalCollisions++;
                    if (firstCollisionIter < 0) firstCollisionIter = i;
                } else {
                    seen[u] = 1;
                }
            }
        }
        assert.equal(
            totalCollisions, 0,
            'expected zero _uuid collisions across ' + iterations + ' constructions of N='
            + data.hotelsWithoutIds.length + ' records; first collision iter='
            + firstCollisionIter + ', total collisions=' + totalCollisions
        );
    });

    it('generated _uuid values are 16 characters of base-62', function () {
        var col = new Collection(data.hotelsWithoutIds);
        for (var i = 0, len = col.length; i < len; i++) {
            assert.equal(col[i]._uuid.length, 16, 'record ' + i + ' has _uuid length ' + col[i]._uuid.length + ' (expected 16)');
            assert.equal(/^[0-9A-Za-z]{16}$/.test(col[i]._uuid), true, 'record ' + i + ' _uuid `' + col[i]._uuid + '` is not 16 chars of base-62');
        }
    });
});
