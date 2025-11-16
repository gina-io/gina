var reporter    = require('nodeunit').reporters.default;
var fs          = require('fs');
var Collection  = require('../src/main');// Not needed if the framework installed
var collectionName = 'hotel';
var data = {
    hotels: JSON.parse(fs.readFileSync(__dirname + '/data/' + collectionName + '.json'))
} ;


var hotels = new Collection(data.hotels);
var result = null, mocks = null;


exports['[ notIn from empty source ] Hotel WHERE country === `France`\n    [ limit ] 2 '] = function(test) {
    var emptySourceColection = new Collection([]);
    
    
    
    result  = emptySourceColection.notIn(
                hotels
                    .find({ country: 'France' })
                    .limit(2)
                ).toRaw();

    mocks   = JSON.parse(fs.readFileSync(__dirname + '/data/result/' + collectionName +'/find/findHotelWhereCountryIsFrance.json'))
                .splice(0, 2);
    
    test.equal(Array.isArray(result), true );
    test.equal(result.length, mocks.length);
    test.deepEqual(result, mocks);

    test.done()
}


// for debug purpose
if (reporter)
    reporter.run(['test/02-notIn.js']);