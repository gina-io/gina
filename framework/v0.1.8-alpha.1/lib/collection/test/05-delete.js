var reporter    = require('nodeunit').reporters.default;
var fs          = require('fs');
var helpers     = require('../../../helpers');// Not needed if the framework installed
var Collection  = require('../src/main');// Not needed if the framework installed
var collectionName = 'hotel';
var data = {
    hotels: JSON.parse(fs.readFileSync(__dirname + '/data/' + collectionName + '.json')),
    hotelsWithoutIds: JSON.parse(fs.readFileSync(__dirname + '/data/' + collectionName + '-without-ids.json')),
    hotelsWithUuids: JSON.parse(fs.readFileSync(__dirname + '/data/' + collectionName + '-with-_uuids.json'))
} ;


var result = null, mocks = null;

var hotels = new Collection(data.hotels);
exports['[ delete ] Hotel  [ where ] `country` = `France` '] = function(test) {

    result  = hotels
                .delete({ country: 'France'})
                .toRaw();

    // fs.writeFileSync(__dirname + '/data/result/' + collectionName +'/delete/deleteHotelWhereCountryIsFrance.json', JSON.stringify(result, null, 4));

    test.equal(Array.isArray(result), true);
    test.equal(result.length, 777); // country

    mocks = requireJSON(__dirname + '/data/result/' + collectionName +'/delete/deleteHotelWhereCountryIsFrance.json');
    test.deepEqual(result, mocks);

    test.done()
}

exports['[ delete ] Hotel [ where ] `vacancy` = true '] = function(test) {

    result  = hotels
                .delete({ vacancy: true })
                .toRaw();

    // fs.writeFileSync(__dirname + '/data/result/' + collectionName +'/delete/deleteHotelWhereVacancyIsTrue.json', JSON.stringify(result, null, 4));

    test.equal(Array.isArray(result), true);
    test.equal(result.length, 449); // vacancy

    mocks = requireJSON(__dirname + '/data/result/' + collectionName +'/delete/deleteHotelWhereVacancyIsTrue.json');
    test.deepEqual(result, mocks);

    test.done()
}

var hotelsWithoutIds = new Collection(data.hotelsWithoutIds);
exports['[ delete ] Hotel without ids  [ where ] `country` = `France` '] = function(test) {

    result  = hotelsWithoutIds
                .delete({ country: 'France'})
                .toRaw();

    // fs.writeFileSync(__dirname + '/data/result/' + collectionName +'/delete/deleteHotelWithoutIdsWhereCountryIsFrance.json', JSON.stringify(result, null, 4));

    test.equal(Array.isArray(result), true);
    test.equal(result.length, 777); // country

    mocks = requireJSON(__dirname + '/data/result/' + collectionName +'/delete/deleteHotelWithoutIdsWhereCountryIsFrance.json');
    test.deepEqual(result, mocks);

    test.done()
}

var hotelsWithUuids = new Collection(data.hotelsWithUuids);
exports['[ delete ] Hotel with uuids [ where ] `country` = `France` '] = function(test) {

    result  = hotelsWithUuids
                .delete({ country: 'France'})
                .toRaw();

    // fs.writeFileSync(__dirname + '/data/result/' + collectionName +'/delete/deleteHotelWithUuidsWhereCountryIsFrance.json', JSON.stringify(result, null, 4));

    test.equal(Array.isArray(result), true);
    test.equal(result.length, 777); // country

    mocks = requireJSON(__dirname + '/data/result/' + collectionName +'/delete/deleteHotelWithUuidsWhereCountryIsFrance.json');
    test.deepEqual(result, mocks);

    test.done()
}


// for debug purpose
if (reporter)
    reporter.run(['test/05-delete.js']);