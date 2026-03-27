var reporter    = require('nodeunit').reporters.default;
var fs          = require('fs');


var deepEqual = function(obj, obj2) {
    return ( JSON.stringify(obj) === JSON.stringify(obj2) ) ? true: false;
}

var Collection  = require('../src/main');// Not needed if the framework installed
var collectionName = 'hotel';
var data = {
    hotels: JSON.parse(fs.readFileSync(__dirname + '/data/' + collectionName + '.json'))
} ;


var hotels = new Collection(data.hotels);
var result = null, mocks = null, query = null;

exports['[ Instance is Array ]'] = function(test) {
    test.equal(Array.isArray(hotels), true);
    test.done()
}

query = 'findHotelWhereCountryIsFrance';
queryFile = fs.readFileSync(__dirname + '/data/result/' + collectionName +'/find/'+query+'.n1ql');
exports['[ find limit ] Hotel WHERE country === `France`\n    [ limit ] 2 \n'+queryFile] = function(test) {
    hotels = new Collection(data.hotels);
    result  = hotels
                .find({ country: 'France' })
                .limit(2)
                .toRaw();

    mocks   = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName +'/find/'+query+'.json'));
    
    test.equal(Array.isArray(result), true );
    test.equal(result.length, mocks.length);
    //test.deepEqual(result, mocks);
    

    test.done();
};

query = 'findHotelWhereNameIs_Le Clos FleuriOrNameIsHotel d_Angleterre';
queryFile = fs.readFileSync(__dirname + '/data/result/' + collectionName +'/find/'+query+'.n1ql');
exports['[ find withOrClause ] \n'+queryFile] = function(test) {
    
    result  = hotels
                .find(
                    { type: 'hotel', name: 'Le Clos Fleuri' }
                    , { type: 'hotel', name: "Hotel d'Angleterre" }
                )
                .toRaw();

    mocks   = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName +'/find/'+query+'.json'));
    
    test.equal(Array.isArray(result), true );
    test.equal(result.length, mocks.length); // 2
    test.equal(deepEqual(result, mocks), true);
    
    test.done();
}

exports['[ find notIn filters ] Hotel WHERE country NOTIN `United Kingdom` OR NOTIN `United States`'] = function(test) {

    result  = hotels
                .notIn({ country: 'United Kingdom' }, { country: 'United States' })
                .toRaw();

    mocks   = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName + '/find/findHotelWhereCountryNotInUkOrNotInUsa.json'));

    test.equal(Array.isArray(result), true);
    test.equal(result.length, mocks.length);
    test.equal(deepEqual(result, mocks), true);
    //test.deepEqual(result, mocks);

    test.done()
}

exports['[ find notIn filters ] Hotel WHERE country NOTIN `United Kingdom` OR NOTIN `United States` Filtered By fields `city` and `id`'] = function(test) {

    result  = hotels
                .notIn({ country: 'United Kingdom' }, { country: 'United States' })
                //.filter('id');
                .filter(['city', 'id']);

    mocks   = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName + '/find/findHotelWhereCountryNotInUkOrNotInUsaFilteredOnIdAndCity.json'));

    test.equal(Array.isArray(result), true);
    test.equal(result.length, mocks.length);
    test.equal(deepEqual(result, mocks), true);

    test.done()
}

exports['[ find notIn Array ] Hotel WHERE country == `United Kingdom` AND city NOTIN `[ "Orange" ]`'] = function(test) {

    var excludedCity = hotels.find({ country: 'France', city: 'Orange' });

    result = hotels
                .find({ country: 'France', state: "Provence-Alpes-Côte d'Azur" })
                .notIn(excludedCity, 'id') // can be written as : .notIn({ country: 'France', city: 'Orange' })
                .toRaw();

    mocks = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName + '/find/findHotelWhereCountryIsFranceAndStateIsPacaAndCityNotInOrange.json'));

    test.equal(Array.isArray(result), true);
    test.equal(result.length, mocks.length);
    test.deepEqual(result, mocks);

    test.done()
}

exports['[ find within ] Hotel WHERE country == Uk AND pets_ok == true AND country == `United Kingdom` AND reviews[*].Cleanliness >= 4'] = function(test) {

    result = hotels
        .find({ country: 'United Kingdom', pets_ok: true, 'reviews[*].ratings.Cleanliness': '>= 4' })
        //.limit(9)
        .toRaw();

    mocks = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName + '/find/findHotelWhereCountryIsUkAndPetsOkAndReviewsCleanlinessRanksMoreThan4.json'));
            //.splice(0, 9);

    test.equal(Array.isArray(result), true);
    test.equal(result.length, mocks.length);
    test.deepEqual(result, mocks);

    test.done()
}

// for debug purpose
if (reporter)
    reporter.run(['test/01-find.js']);